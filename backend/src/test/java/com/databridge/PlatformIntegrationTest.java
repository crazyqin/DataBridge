package com.databridge;

import static org.junit.jupiter.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;
import java.sql.Connection;
import java.util.*;
import java.util.concurrent.*;
import org.springframework.mock.web.MockHttpSession;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;

@SpringBootTest
@AutoConfigureMockMvc
@org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable(named="TEST_DB_URL",matches=".+")
class PlatformIntegrationTest {
  @DynamicPropertySource static void properties(DynamicPropertyRegistry props) {
    props.add("spring.datasource.url",()->System.getenv("TEST_DB_URL"));
    props.add("spring.datasource.username",()->System.getenv("TEST_DB_USERNAME"));
    props.add("spring.datasource.password",()->System.getenv("TEST_DB_PASSWORD"));
    props.add("app.secret-key",()->Base64.getEncoder().encodeToString(new byte[32]));
    props.add("app.api-key",()->"test-api-key");
    props.add("app.admin-username",()->"admin");
    props.add("app.admin-password-hash",()->new org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder().encode("test-password-123"));
  }
  @Autowired JdbcTemplate jdbc;
  @Autowired DatasourceService sources;
  @Autowired ApiService apis;
  @Autowired AdminAccountService accounts;
  @Autowired MockMvc mvc;
  @BeforeEach void clear() {
    jdbc.execute("TRUNCATE api_request_log,api_row_sort,api_data_row,api_config,datasource RESTART IDENTITY CASCADE");
    jdbc.execute("CREATE TABLE IF NOT EXISTS source_item(item_id text,item_name text)");
    jdbc.execute("TRUNCATE source_item");
    jdbc.update("UPDATE admin_account SET password_hash=? WHERE username='admin'",
      new org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder().encode("test-password-123"));
  }
  private long source() {
    var source=sources.save(null,Map.of("name","test","dbType","POSTGRESQL","jdbcUrl",System.getenv("TEST_DB_URL"),
      "username",System.getenv("TEST_DB_USERNAME"),"password",System.getenv("TEST_DB_PASSWORD"),"enabled",true));
    assertFalse(source.containsKey("passwordEnc"));
    return ((Number)source.get("id")).longValue();
  }
  private Map<String,Object> config(String mode,long source) {
    var body=new HashMap<String,Object>();body.put("name","test API");body.put("code","test_api");body.put("path","/open/items");
    body.put("httpMethod","GET");body.put("dataMode",mode);body.put("enabled",true);body.put("maxRows",10);body.put("timeoutSeconds",2);
    if(!mode.equals("MANUAL")) body.put("datasourceId",source);
    return body;
  }
  private Map<String,Object> saveExisting(long id,Map<String,Object> body) {
    body.put("configVersion",apis.get(id).get("configVersion"));
    return apis.save(id,body);
  }
  private Map<String,Object> manualUpdateCurrent(long id,String key,Map<String,Object> data) {
    Long version=jdbc.queryForObject("SELECT row_version FROM api_data_row WHERE api_id=? AND row_key=?",Long.class,id,key);
    return apis.manualUpdate(id,key,version,data);
  }
  private void insert(String... ids) { for(String id:ids) jdbc.update("INSERT INTO source_item(item_id,item_name) VALUES(?,?)",id,"name-"+id); }
  @Test void snapshotKeepsOrderAndOldDataOnFailures() {
    long source=source();insert("A","B","C");
    var body=config("SNAPSHOT",source);body.put("sqlText","SELECT item_id,item_name FROM source_item ORDER BY item_id");
    body.put("rowKeyFields",List.of("item_id"));body.put("syncCron","0 0 * * * *");
    long id=((Number)apis.save(null,body).get("id")).longValue();
    assertEquals(3,apis.sync(id).get("count"));
    var first=apis.rows(id);var byId=new HashMap<String,String>();
    for(var row:first) byId.put((String)((Map<?,?>)row.get("dataJson")).get("item_id"),(String)row.get("rowKey"));
    apis.sort(id,List.of(Map.of("rowKey",byId.get("C"),"sortNo",1),Map.of("rowKey",byId.get("A"),"sortNo",2),Map.of("rowKey",byId.get("B"),"sortNo",3)));
    jdbc.update("DELETE FROM source_item WHERE item_id='B'");insert("D");apis.sync(id);
    assertEquals(List.of("C","A","D"),ids(apis.rows(id)));
    assertEquals(0,jdbc.queryForObject("SELECT count(*) FROM api_row_sort WHERE row_key=?",Integer.class,byId.get("B")));
    jdbc.update("TRUNCATE source_item");
    assertThrows(ApiException.class,()->apis.sync(id));
    assertEquals(List.of("C","A","D"),ids(apis.rows(id)));
    insert("A","A");assertThrows(ApiException.class,()->apis.sync(id));
    assertEquals(List.of("C","A","D"),ids(apis.rows(id)));
    jdbc.execute("DROP TABLE source_item");assertThrows(ApiException.class,()->apis.sync(id));
    assertEquals(List.of("C","A","D"),ids(apis.rows(id)));
    sources.save(source,Map.of("name","broken","dbType","POSTGRESQL","jdbcUrl","jdbc:postgresql://127.0.0.1:1/none",
      "username",System.getenv("TEST_DB_USERNAME"),"password","","enabled",true));
    assertThrows(ApiException.class,()->apis.sync(id));
    assertEquals(List.of("C","A","D"),ids(apis.rows(id)));
  }
  private List<String> ids(List<Map<String,Object>> rows) { return rows.stream().map(r->(String)((Map<?,?>)r.get("dataJson")).get("item_id")).toList(); }
  @Test void explicitlyAllowedEmptySyncClearsSnapshot() {
    long source=source();insert("A");
    var body=config("SNAPSHOT",source);body.put("sqlText","SELECT item_id,item_name FROM source_item");
    body.put("rowKeyFields",List.of("item_id"));body.put("syncCron","0 0 * * * *");
    long id=((Number)apis.save(null,body).get("id")).longValue();
    apis.sync(id);assertEquals(1,apis.rows(id).size());
    jdbc.execute("TRUNCATE source_item");body.put("allowEmptySync",true);saveExisting(id,body);
    assertEquals(0,apis.sync(id).get("count"));assertTrue(apis.rows(id).isEmpty());
  }
  @Test void realtimeBindsParametersAndEnforcesLimits() throws Exception {
    long source=source();insert("A","B");
    var body=config("REALTIME",source);body.put("sqlText","SELECT item_id,item_name FROM source_item WHERE item_id=:id");
    body.put("paramSchema",List.of(Map.of("name","id","type","string","required",true)));
    long id=((Number)apis.save(null,body).get("id")).longValue();
    mvc.perform(get("/open/items").header("X-API-Key","test-api-key").param("id","A"))
      .andExpect(status().isOk()).andExpect(jsonPath("$.data[0].item_id").value("A"));
    mvc.perform(get("/open/items").header("X-API-Key","test-api-key"))
      .andExpect(status().isBadRequest()).andExpect(jsonPath("$.message").value("missing parameter: id"));
    mvc.perform(get("/open/items").header("X-API-Key","wrong").param("id","A")).andExpect(status().isUnauthorized());
    assertThrows(ApiException.class,()->apis.save(null,Map.of("name","bad","code","bad","path","/open/bad","dataMode","REALTIME","datasourceId",source,"sqlText","DELETE FROM source_item")));
    body.put("sqlText","SELECT item_id FROM source_item");body.put("paramSchema",List.of());body.put("maxRows",1);saveExisting(id,body);
    mvc.perform(get("/open/items").header("X-API-Key","test-api-key"))
      .andExpect(status().isUnprocessableEntity()).andExpect(jsonPath("$.code").value(50023));
    body.put("sqlText","SELECT pg_sleep(3)");body.put("timeoutSeconds",1);body.put("maxRows",10);saveExisting(id,body);
    mvc.perform(get("/open/items").header("X-API-Key","test-api-key"))
      .andExpect(status().isGatewayTimeout()).andExpect(jsonPath("$.code").value(50022));
    body.put("sqlText","SELECT item_id FROM source_item WHERE item_id=:id");body.put("httpMethod","POST");
    body.put("paramSchema",List.of(Map.of("name","id","type","string","required",true)));saveExisting(id,body);
    mvc.perform(post("/open/items").header("X-API-Key","test-api-key").contentType("application/json").content("{\"id\":\"B\"}"))
      .andExpect(status().isOk()).andExpect(jsonPath("$.data[0].item_id").value("B"));
    assertEquals(6,jdbc.queryForObject("SELECT count(*) FROM api_request_log",Integer.class));
    assertEquals(4,jdbc.queryForObject("SELECT count(*) FROM api_request_log WHERE success=false",Integer.class));
  }
  @Test void manualCrudIsImmediatelyVisible() throws Exception {
    var body=config("MANUAL",0);body.put("manualSchema",List.of(Map.of("name","code","type","string","required",true),Map.of("name","enabled","type","boolean","required",false)));
    body.put("filterFields",List.of("code"));body.put("authMode","PUBLIC");
    body.put("allowedUserAgents",List.of("DataBridgeTest/*"));
    long id=((Number)apis.save(null,body).get("id")).longValue();
    var row=apis.manualCreate(id,Map.of("code","A","enabled",true));String key=(String)row.get("rowKey");
    mvc.perform(get("/open/items").header("User-Agent","DataBridgeTest/1.0").param("code","A"))
      .andExpect(status().isOk()).andExpect(jsonPath("$.meta.count").value(1));
    mvc.perform(get("/open/items").header("User-Agent","Other/1.0").param("code","A"))
      .andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value(40301));
    mvc.perform(get("/open/items").param("code","A")).andExpect(status().isForbidden());
    body.put("authMode","API_KEY");saveExisting(id,body);
    mvc.perform(get("/open/items").param("code","A")).andExpect(status().isUnauthorized());
    mvc.perform(get("/open/items").header("X-API-Key","test-api-key").header("User-Agent","DataBridgeTest/1.0").param("code","A"))
      .andExpect(status().isOk());
    body.put("allowedUserAgents",List.of());saveExisting(id,body);
    manualUpdateCurrent(id,key,Map.of("code","B","enabled",false));
    mvc.perform(get("/open/items").header("X-API-Key","test-api-key").param("code","A"))
      .andExpect(jsonPath("$.meta.count").value(0));
    apis.manualDelete(id,key);
    assertTrue(apis.rows(id).isEmpty());
  }
  @Test void administratorCanChangePasswordWithoutStoringPlaintext() throws Exception {
    var authenticatedUser=(AdminAccountService.AdminUser)accounts.loadUserByUsername("admin");
    MockHttpSession session=(MockHttpSession)mvc.perform(post("/auth/login").with(csrf()).param("username","admin").param("password","test-password-123"))
      .andExpect(status().isNoContent()).andReturn().getRequest().getSession(false);
    assertNotNull(session);
    MockHttpSession other=(MockHttpSession)mvc.perform(post("/auth/login").with(csrf()).param("username","admin").param("password","test-password-123"))
      .andExpect(status().isNoContent()).andReturn().getRequest().getSession(false);
    mvc.perform(get("/admin/session").session(session)).andExpect(status().isOk()).andExpect(jsonPath("$.username").value("admin"));
    mvc.perform(post("/admin/password").session(session).with(csrf()).contentType("application/json")
        .content("{\"currentPassword\":\"wrong-password\",\"newPassword\":\"new-password-456\"}"))
      .andExpect(status().isBadRequest());
    mvc.perform(post("/admin/password").session(session).with(csrf()).contentType("application/json")
        .content("{\"currentPassword\":\"test-password-123\",\"newPassword\":\"new-password-456\"}"))
      .andExpect(status().isOk());
    mvc.perform(get("/admin/session").session(other)).andExpect(status().isUnauthorized());
    String hash=jdbc.queryForObject("SELECT password_hash FROM admin_account WHERE username='admin'",String.class);
    assertNotNull(hash);assertTrue(hash.startsWith("$2"));assertNotEquals("new-password-456",hash);
    assertNotEquals(hash,authenticatedUser.passwordHash());
    assertFalse(accounts.passwordHashMatches(authenticatedUser.username(),authenticatedUser.passwordHash()));
    mvc.perform(post("/auth/login").with(csrf()).param("username","admin").param("password","test-password-123"))
      .andExpect(status().isUnauthorized());
    mvc.perform(post("/auth/login").with(csrf()).param("username","admin").param("password","new-password-456"))
      .andExpect(status().isNoContent());
  }
  @Test void passwordLongerThanBcryptLimitIsRejectedBeforeHashing() throws Exception {
    MockHttpSession session=(MockHttpSession)mvc.perform(post("/auth/login").with(csrf()).param("username","admin").param("password","test-password-123"))
      .andExpect(status().isNoContent()).andReturn().getRequest().getSession(false);
    String before=accounts.currentPasswordHash("admin");
    for(String tooLong:List.of("x".repeat(73),"密".repeat(25)))
      mvc.perform(post("/admin/password").session(session).with(csrf()).contentType("application/json")
          .content("{\"currentPassword\":\"test-password-123\",\"newPassword\":\""+tooLong+"\"}"))
        .andExpect(status().isBadRequest()).andExpect(jsonPath("$.message").value("new password must be at most 72 UTF-8 bytes"));
    assertEquals(before,accounts.currentPasswordHash("admin"));
  }
  @Test void adminWriteRequiresCsrfEvenWithSessionAndForeignOrigin() throws Exception {
    MockHttpSession session=(MockHttpSession)mvc.perform(post("/auth/login").with(csrf()).param("username","admin").param("password","test-password-123"))
      .andExpect(status().isNoContent()).andReturn().getRequest().getSession(false);
    long source=source();
    var body=config("MANUAL",source);body.put("manualSchema",List.of(Map.of("name","code","type","string")));
    long id=((Number)apis.save(null,body).get("id")).longValue();
    mvc.perform(post("/admin/apis/"+id+"/disable").session(session).header("Origin","http://localhost:5173"))
      .andExpect(status().isForbidden());
    assertEquals(true,apis.get(id).get("enabled"));
    mvc.perform(post("/admin/apis/"+id+"/disable").session(session).with(csrf())).andExpect(status().isOk());
    assertEquals(false,apis.get(id).get("enabled"));
  }
  @Test void configChangedDuringSyncPreservesNewManualRows() throws Exception {
    long source=source();insert("A");
    var body=config("SNAPSHOT",source);body.put("sqlText","SELECT item_id,item_name,pg_sleep(2) FROM source_item LIMIT 1");
    body.put("rowKeyFields",List.of("item_id"));body.put("syncCron","0 0 * * * *");body.put("timeoutSeconds",5);
    long id=((Number)apis.save(null,body).get("id")).longValue();
    var future=CompletableFuture.supplyAsync(()->apis.sync(id));
    boolean running=false;
    for(int i=0;i<60;i++) {
      running=Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE state='active' AND query LIKE 'SELECT item_id,item_name,pg_sleep(2)%')",Boolean.class));
      if(running) break;
      Thread.sleep(50);
    }
    assertTrue(running,"sync query did not start");
    body.put("dataMode","MANUAL");body.put("manualSchema",List.of(Map.of("name","code","type","string","required",true)));
    saveExisting(id,body);
    apis.manualCreate(id,Map.of("code","new"));
    assertThrows(ExecutionException.class,()->future.get(8,TimeUnit.SECONDS));
    assertEquals("new",((Map<?,?>)apis.rows(id).get(0).get("dataJson")).get("code"));
  }
  @Test void manualWritesCannotCommitAfterSwitchingToSnapshot() throws Exception {
    long source=source();var body=config("MANUAL",source);
    body.put("manualSchema",List.of(Map.of("name","code","type","string")));
    long id=((Number)apis.save(null,body).get("id")).longValue();
    jdbc.execute("CREATE FUNCTION wait_for_manual_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_lock(9325784); PERFORM pg_advisory_unlock(9325784); RETURN NEW; END; $$");
    jdbc.execute("CREATE TRIGGER wait_for_manual_insert BEFORE INSERT ON api_data_row FOR EACH ROW EXECUTE FUNCTION wait_for_manual_insert()");
    try(var holder=Objects.requireNonNull(jdbc.getDataSource()).getConnection();var statement=holder.createStatement()) {
      statement.execute("SELECT pg_advisory_lock(9325784)");
      var inserting=CompletableFuture.supplyAsync(()->apis.manualCreate(id,Map.of("code","late")));
      try {
        boolean waiting=false;
        for(int i=0;i<100;i++) {
          waiting=Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event='advisory' AND query LIKE 'INSERT INTO api_data_row%')",Boolean.class));
          if(waiting) break;
          Thread.sleep(20);
        }
        assertTrue(waiting,"manual insert did not reach the database");
        body.put("dataMode","SNAPSHOT");body.put("datasourceId",source);
        body.put("sqlText","SELECT 7 AS id");body.put("rowKeyFields",List.of("id"));body.put("syncCron","0 0 * * * *");
        var changing=CompletableFuture.supplyAsync(()->saveExisting(id,body));
        Thread.sleep(100);
        assertFalse(changing.isDone(),"mode change must wait for manual write");
        statement.execute("SELECT pg_advisory_unlock(9325784)");
        inserting.get(5,TimeUnit.SECONDS);changing.get(5,TimeUnit.SECONDS);
        assertTrue(apis.rows(id).isEmpty());
      } finally { statement.execute("SELECT pg_advisory_unlock(9325784)"); }
    } finally {
      jdbc.execute("DROP TRIGGER wait_for_manual_insert ON api_data_row");
      jdbc.execute("DROP FUNCTION wait_for_manual_insert()");
    }
  }
  @Test void manualSchemaChangeRemovesObsoleteFieldsFromStoredAndPublishedRows() throws Exception {
    var body=config("MANUAL",0);body.put("authMode","PUBLIC");
    body.put("manualSchema",List.of(Map.of("name","code","type","string"),Map.of("name","secret","type","string")));
    long id=((Number)apis.save(null,body).get("id")).longValue();
    var created=apis.manualCreate(id,Map.of("code","A","secret","old secret"));
    body.put("manualSchema",List.of(Map.of("name","code","type","string")));
    saveExisting(id,body);
    assertFalse(jdbc.queryForObject("SELECT data_json::text FROM api_data_row WHERE api_id=?",String.class,id).contains("secret"));
    assertEquals(Map.of("code","A"),apis.rows(id).get(0).get("dataJson"));
    mvc.perform(get("/open/items")).andExpect(status().isOk()).andExpect(jsonPath("$.data[0].secret").doesNotExist());
    manualUpdateCurrent(id,(String)created.get("rowKey"),Map.of("code","B"));
  }
  @Test void manualConfigSaveKeepsDecimalPrecisionAndAdminNumbersAsStrings() throws Exception {
    var body=config("MANUAL",0);body.put("authMode","PUBLIC");
    body.put("manualSchema",List.of(Map.of("name","amount","type","decimal"),Map.of("name","id","type","integer")));
    long id=((Number)apis.save(null,body).get("id")).longValue();
    String amount="1234567890.12345678901234567890",integer="9007199254740993";
    String key=(String)apis.manualCreate(id,Map.of("amount",amount,"id",integer)).get("rowKey");
    body.put("name","renamed only");saveExisting(id,body);
    assertEquals(amount,jdbc.queryForObject("SELECT data_json->>'amount' FROM api_data_row WHERE api_id=?",String.class,id));
    assertEquals(integer,jdbc.queryForObject("SELECT data_json->>'id' FROM api_data_row WHERE api_id=?",String.class,id));
    assertEquals(Map.of("amount",amount,"id",integer),apis.rows(id).get(0).get("dataJson"));
    manualUpdateCurrent(id,key,(Map<String,Object>)apis.rows(id).get(0).get("dataJson"));
    assertEquals(integer,jdbc.queryForObject("SELECT data_json->>'id' FROM api_data_row WHERE api_id=?",String.class,id));
    mvc.perform(get("/open/items")).andExpect(status().isOk())
      .andExpect(result -> assertTrue(result.getResponse().getContentAsString().contains(amount)));
  }
  @Test void blankOptionalManualNumbersBecomeNull() {
    var body=config("MANUAL",0);
    body.put("manualSchema",List.of(Map.of("name","amount","type","decimal"),Map.of("name","id","type","integer")));
    long id=((Number)apis.save(null,body).get("id")).longValue();
    String key=(String)apis.manualCreate(id,Map.of("amount","42.75","id","7")).get("rowKey");
    manualUpdateCurrent(id,key,Map.of("amount","","id","  "));
    var data=(Map<?,?>)apis.rows(id).get(0).get("dataJson");
    assertNull(data.get("amount"));assertNull(data.get("id"));
    body.put("manualSchema",List.of(Map.of("name","amount","type","decimal","required",true)));
    assertThrows(ApiException.class,()->saveExisting(id,body));
  }
  @Test void jdbcArraysAndJsonAreReturnedAsJsonValues() throws Exception {
    long source=source();var body=config("REALTIME",source);body.put("authMode","PUBLIC");
    body.put("sqlText","SELECT ARRAY[1,2] AS ids, '{\"name\":\"A\"}'::jsonb AS payload");
    apis.save(null,body);
    mvc.perform(get("/open/items")).andExpect(status().isOk())
      .andExpect(jsonPath("$.data[0].ids[1]").value(2))
      .andExpect(jsonPath("$.data[0].payload.name").value("A"));
  }
  @Test void duplicateSqlColumnLabelsAreRejected() throws Exception {
    long source=source();var body=config("REALTIME",source);body.put("authMode","PUBLIC");
    body.put("sqlText","SELECT 1 AS id, 2 AS id");
    apis.save(null,body);
    mvc.perform(get("/open/items")).andExpect(status().isBadRequest())
      .andExpect(jsonPath("$.message").value("SQL result contains duplicate column label: id"));
  }
  @Test void snapshotDatetimeFilterMatchesStoredTimestamp() {
    long source=source();var body=config("SNAPSHOT",source);
    body.put("sqlText","SELECT 1 AS id, TIMESTAMP '2026-09-25 10:00:00' AS happened_at");
    body.put("rowKeyFields",List.of("id"));body.put("syncCron","0 0 * * * *");
    body.put("filterFields",List.of("happened_at"));
    body.put("paramSchema",List.of(Map.of("name","happened_at","type","datetime")));
    long id=((Number)apis.save(null,body).get("id")).longValue();
    apis.sync(id);
    assertEquals("2026-09-25T10:00:00",((Map<?,?>)apis.rows(id).get(0).get("dataJson")).get("happened_at"));
    assertEquals(1,apis.query(apis.get(id),Map.of("happened_at","2026-09-25T10:00:00")).size());
  }
  @Test void firstSyncAfterTimestampFormatUpgradeKeepsLegacySort() {
    long source=source();var body=config("SNAPSHOT",source);
    body.put("sqlText","SELECT 1 AS id, TIMESTAMP '2026-09-25 10:00:00' AS happened_at UNION ALL SELECT 2 AS id, TIMESTAMP '2026-09-25 11:00:00' AS happened_at");
    body.put("rowKeyFields",List.of("happened_at"));body.put("syncCron","0 0 * * * *");
    long id=((Number)apis.save(null,body).get("id")).longValue();
    var json=new Json(new com.fasterxml.jackson.databind.ObjectMapper());
    for(int i=1;i<=2;i++) {
      String oldTime="2026-09-25T"+(i==1?"10":"11")+":00";
      String oldKey=RowKeys.key(Map.of("happened_at",oldTime),List.of("happened_at"),json);
      jdbc.update("INSERT INTO api_data_row(api_id,row_key,data_json,source_order) VALUES(?,?,?::jsonb,?)",
        id,oldKey,json.write(Map.of("id",i,"happened_at",oldTime)),i-1);
      jdbc.update("INSERT INTO api_row_sort(api_id,row_key,sort_no) VALUES(?,?,?)",id,oldKey,3-i);
    }
    apis.sync(id);
    assertEquals(List.of(2,1),apis.rows(id).stream().map(row -> ((Map<?,?>)row.get("dataJson")).get("id")).toList());
    assertEquals(2,jdbc.queryForObject("SELECT count(*) FROM api_row_sort WHERE api_id=?",Integer.class,id));
    apis.sync(id);
    assertEquals(List.of(2,1),apis.rows(id).stream().map(row -> ((Map<?,?>)row.get("dataJson")).get("id")).toList());
  }
  @Test void legacyTimestampMigrationDoesNotRewriteTextKeys() {
    long source=source();var body=config("SNAPSHOT",source);
    body.put("sqlText","SELECT '2026-09-25T10:00'::text AS key UNION ALL SELECT 'remaining'::text AS key");
    body.put("rowKeyFields",List.of("key"));body.put("syncCron","0 0 * * * *");
    long id=((Number)apis.save(null,body).get("id")).longValue();
    apis.sync(id);
    var rows=apis.rows(id);
    apis.sort(id,List.of(Map.of("rowKey",rows.get(0).get("rowKey"),"sortNo",1),Map.of("rowKey",rows.get(1).get("rowKey"),"sortNo",2)));
    body.put("sqlText","SELECT '2026-09-25T10:00:00'::text AS key UNION ALL SELECT 'remaining'::text AS key");
    saveExisting(id,body);apis.sync(id);
    assertEquals(List.of("remaining","2026-09-25T10:00:00"),apis.rows(id).stream()
      .map(row -> ((Map<?,?>)row.get("dataJson")).get("key")).toList());
    assertEquals(1,jdbc.queryForObject("SELECT count(*) FROM api_row_sort WHERE api_id=?",Integer.class,id));
  }
  @Test void timestampAndTextCompositeLegacyKeysKeepTheirSort() {
    long source=source();var body=config("SNAPSHOT",source);
    body.put("sqlText","SELECT 1 AS id, TIMESTAMP '2026-09-25 10:00:00' AS happened_at, '2026-09-25T12:00:00'::text AS reference UNION ALL SELECT 2 AS id, TIMESTAMP '2026-09-25 11:00:00' AS happened_at, '2026-09-25T12:00:00'::text AS reference");
    body.put("rowKeyFields",List.of("happened_at","reference"));body.put("syncCron","0 0 * * * *");
    long id=((Number)apis.save(null,body).get("id")).longValue();
    var json=new Json(new com.fasterxml.jackson.databind.ObjectMapper());
    for(int i=1;i<=2;i++) {
      String oldTime="2026-09-25T"+(i==1?"10":"11")+":00";
      String reference="2026-09-25T12:00:00";
      String oldKey=RowKeys.key(Map.of("happened_at",oldTime,"reference",reference),List.of("happened_at","reference"),json);
      jdbc.update("INSERT INTO api_data_row(api_id,row_key,data_json,source_order) VALUES(?,?,?::jsonb,?)",
        id,oldKey,json.write(Map.of("id",i,"happened_at",oldTime,"reference",reference)),i-1);
      jdbc.update("INSERT INTO api_row_sort(api_id,row_key,sort_no) VALUES(?,?,?)",id,oldKey,3-i);
    }
    apis.sync(id);
    assertEquals(List.of(2,1),apis.rows(id).stream().map(row -> ((Map<?,?>)row.get("dataJson")).get("id")).toList());
  }
  @Test void openRequestCannotReadRowsWrittenAfterAccessPolicyChanged() throws Exception {
    long source=source();var body=config("SNAPSHOT",source);
    body.put("sqlText","SELECT 'old-public' AS key");body.put("rowKeyFields",List.of("key"));
    body.put("syncCron","0 0 0 1 1 *");body.put("authMode","PUBLIC");
    long id=((Number)apis.save(null,body).get("id")).longValue();apis.sync(id);
    jdbc.execute("CREATE FUNCTION audit_pause_public_lookup() RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$ BEGIN IF current_query() LIKE 'SELECT * FROM api_config WHERE path=%' THEN PERFORM pg_advisory_lock(938271); PERFORM pg_advisory_unlock(938271); END IF; RETURN true; END $$");
    jdbc.execute("ALTER TABLE api_config RENAME TO audit_api_config");
    jdbc.execute("CREATE VIEW api_config AS SELECT * FROM audit_api_config WHERE audit_pause_public_lookup()");
    try(Connection holder=Objects.requireNonNull(jdbc.getDataSource()).getConnection();var statement=holder.createStatement()) {
      statement.execute("SELECT pg_advisory_lock(938271)");
      var pending=CompletableFuture.supplyAsync(() -> {
        try {return mvc.perform(get("/open/items")).andReturn();}
        catch(Exception e) {throw new CompletionException(e);}
      });
      try {
        boolean waiting=false;
        for(int i=0;i<100;i++) {
          waiting=Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event='advisory' AND query LIKE 'SELECT * FROM api_config WHERE path=%')",Boolean.class));
          if(waiting) break;
          Thread.sleep(20);
        }
        assertTrue(waiting,"public lookup did not reach pause point");
        body.put("dataMode","MANUAL");body.put("authMode","API_KEY");
        body.put("manualSchema",List.of(Map.of("name","secret","type","string")));
        saveExisting(id,body);apis.manualCreate(id,Map.of("secret","new-private-record"));
        statement.execute("SELECT pg_advisory_unlock(938271)");
        var response=pending.get(10,TimeUnit.SECONDS).getResponse();
        assertTrue(response.getStatus()==401 || response.getStatus()==409);
        assertFalse(response.getContentAsString().contains("new-private-record"));
        mvc.perform(get("/open/items")).andExpect(status().isUnauthorized());
      } finally {statement.execute("SELECT pg_advisory_unlock(938271)");}
    } finally {
      jdbc.execute("DROP VIEW api_config");
      jdbc.execute("ALTER TABLE audit_api_config RENAME TO api_config");
      jdbc.execute("DROP FUNCTION audit_pause_public_lookup()");
    }
  }
  @Test void adminRowsPageThroughDataBeyondPublicLimit() {
    var body=config("MANUAL",0);body.put("maxRows",1);
    body.put("manualSchema",List.of(Map.of("name","code","type","string")));
    long id=((Number)apis.save(null,body).get("id")).longValue();
    for(int i=0;i<3;i++) apis.manualCreate(id,Map.of("code",String.valueOf(i)));
    assertEquals(3,apis.rows(id).size());
    var second=apis.pageRows(id,2,1);
    assertEquals(3,second.get("total"));
    assertEquals("1",((Map<?,?>)((Map<?,?>)((List<?>)second.get("items")).get(0)).get("dataJson")).get("code"));
    assertThrows(ApiException.class,()->apis.query(apis.get(id),Map.of()));
  }
  @Test void staleApiAndManualRowVersionsCannotOverwriteNewerChanges() {
    var body=config("MANUAL",0);body.put("authMode","PUBLIC");
    body.put("manualSchema",List.of(Map.of("name","a","type","string"),Map.of("name","b","type","string")));
    long id=((Number)apis.save(null,body).get("id")).longValue();
    var stale=new HashMap<String,Object>(body);stale.put("configVersion",0);
    body.put("authMode","API_KEY");saveExisting(id,body);
    stale.put("name","stale page");
    var error=assertThrows(ApiException.class,()->apis.save(id,stale));
    assertEquals(409,error.status.value());assertEquals("API_KEY",apis.get(id).get("authMode"));
    var created=apis.manualCreate(id,Map.of("a","old-a","b","old-b"));
    String key=(String)created.get("rowKey");
    apis.manualUpdate(id,key,0,Map.of("a","new-a","b","old-b"));
    var conflict=assertThrows(ApiException.class,()->apis.manualUpdate(id,key,0,Map.of("a","old-a","b","new-b")));
    assertEquals(409,conflict.status.value());
    assertEquals("new-a",((Map<?,?>)apis.rows(id).get(0).get("dataJson")).get("a"));
  }
  @Test void disablingDatasourceClosesCachedPoolAndBlocksNewQueries() {
    long source=source();var body=config("REALTIME",source);body.put("sqlText","SELECT 1 AS id");
    long id=((Number)apis.save(null,body).get("id")).longValue();
    assertEquals(1,apis.test(id,Map.of()).get("count"));
    sources.save(source,Map.of("name","disabled","dbType","POSTGRESQL","jdbcUrl",System.getenv("TEST_DB_URL"),
      "username",System.getenv("TEST_DB_USERNAME"),"password","","enabled",false));
    assertThrows(ApiException.class,()->apis.test(id,Map.of()));
  }
  @Test void sqlParametersLiteralsJsonOperatorsAndTimeValuesWork() {
    long source=source();var body=config("REALTIME",source);body.put("authMode","PUBLIC");
    body.put("paramSchema",List.of(Map.of("name","p","type","integer","required",false)));
    body.put("sqlText","SELECT 1 AS id WHERE :p IS NULL OR 1 = :p");
    long id=((Number)apis.save(null,body).get("id")).longValue();
    assertEquals(1,apis.test(id,Map.of()).get("count"));
    body.put("paramSchema",List.of());
    body.put("sqlText","SELECT $$abc:def$$ AS label, '{\"k\":1}'::jsonb ? 'k' AS present");
    saveExisting(id,body);
    var row=((List<Map<String,Object>>)apis.test(id,Map.of()).get("data")).get(0);
    assertEquals("abc:def",row.get("label"));assertEquals(true,row.get("present"));
    body.put("sqlText","SELECT E'it\\'s' AS label, TIME '10:20:30.123456' AS t, TIMETZ '10:20:30.123456+08:00' AS tz, TIMESTAMPTZ '2026-09-25 10:20:30.123456+08:00' AS ts");
    saveExisting(id,body);
    row=((List<Map<String,Object>>)apis.test(id,Map.of()).get("data")).get(0);
    assertEquals("it's",row.get("label"));assertEquals("10:20:30.123456",row.get("t"));
    assertTrue(String.valueOf(row.get("tz")).endsWith("+08:00"));
    assertTrue(String.valueOf(row.get("ts")).endsWith("Z"));
  }
  @Test void nullFilteringPreservesJsonNullAndSnapshotTimeKeys() throws Exception {
    var body=config("MANUAL",0);body.put("authMode","PUBLIC");body.put("httpMethod","POST");
    body.put("manualSchema",List.of(Map.of("name","n","type","integer"),Map.of("name","s","type","string")));
    body.put("filterFields",List.of("n","s"));
    long id=((Number)apis.save(null,body).get("id")).longValue();
    var input=new HashMap<String,Object>();input.put("n",null);input.put("s","other");
    apis.manualCreate(id,input);
    mvc.perform(post("/open/items").contentType("application/json").content("{\"n\":null}"))
      .andExpect(status().isOk()).andExpect(jsonPath("$.meta.count").value(1));
    var snapshot=config("SNAPSHOT",source());snapshot.put("sqlText","SELECT TIME '10:20:30.1' AS t UNION ALL SELECT TIME '10:20:30.2' AS t");
    snapshot.put("rowKeyFields",List.of("t"));snapshot.put("syncCron","0 0 * * * *");
    snapshot.put("path","/open/time-keys");snapshot.put("code","time_keys");
    long snapshotId=((Number)apis.save(null,snapshot).get("id")).longValue();
    assertEquals(2,apis.sync(snapshotId).get("count"));
  }
  @Test void invalidInputsReturnBadRequest() throws Exception {
    mvc.perform(get("/admin/logs?apiId=abc").with(org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.user("admin")))
      .andExpect(status().isBadRequest());
    var body=config("MANUAL",0);body.put("name","a".repeat(101));
    body.put("manualSchema",List.of(Map.of("name","x","type","string")));
    assertEquals(400,assertThrows(ApiException.class,()->apis.save(null,body)).status.value());
    body.put("name","valid");body.put("manualSchema",List.of(Map.of("type","string")));
    assertEquals(400,assertThrows(ApiException.class,()->apis.save(null,body)).status.value());
    body.put("manualSchema",List.of(Map.of("name","x","type","string","required","true")));
    assertEquals(400,assertThrows(ApiException.class,()->apis.save(null,body)).status.value());
  }
}
