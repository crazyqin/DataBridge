package com.databridge;

import static org.junit.jupiter.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;
import java.util.*;
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
    jdbc.execute("TRUNCATE source_item");body.put("allowEmptySync",true);apis.save(id,body);
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
    body.put("sqlText","SELECT item_id FROM source_item");body.put("paramSchema",List.of());body.put("maxRows",1);apis.save(id,body);
    mvc.perform(get("/open/items").header("X-API-Key","test-api-key"))
      .andExpect(status().isUnprocessableEntity()).andExpect(jsonPath("$.code").value(50023));
    body.put("sqlText","SELECT pg_sleep(3)");body.put("timeoutSeconds",1);body.put("maxRows",10);apis.save(id,body);
    mvc.perform(get("/open/items").header("X-API-Key","test-api-key"))
      .andExpect(status().isGatewayTimeout()).andExpect(jsonPath("$.code").value(50022));
    body.put("sqlText","SELECT item_id FROM source_item WHERE item_id=:id");body.put("httpMethod","POST");
    body.put("paramSchema",List.of(Map.of("name","id","type","string","required",true)));apis.save(id,body);
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
    body.put("authMode","API_KEY");apis.save(id,body);
    mvc.perform(get("/open/items").param("code","A")).andExpect(status().isUnauthorized());
    mvc.perform(get("/open/items").header("X-API-Key","test-api-key").header("User-Agent","DataBridgeTest/1.0").param("code","A"))
      .andExpect(status().isOk());
    body.put("allowedUserAgents",List.of());apis.save(id,body);
    apis.manualUpdate(id,key,Map.of("code","B","enabled",false));
    mvc.perform(get("/open/items").header("X-API-Key","test-api-key").param("code","A"))
      .andExpect(jsonPath("$.meta.count").value(0));
    apis.manualDelete(id,key);
    assertTrue(apis.rows(id).isEmpty());
  }
  @Test void administratorCanChangePasswordWithoutStoringPlaintext() throws Exception {
    MockHttpSession session=(MockHttpSession)mvc.perform(post("/auth/login").param("username","admin").param("password","test-password-123"))
      .andExpect(status().isNoContent()).andReturn().getRequest().getSession(false);
    assertNotNull(session);
    mvc.perform(get("/admin/session").session(session)).andExpect(status().isOk()).andExpect(jsonPath("$.username").value("admin"));
    mvc.perform(post("/admin/password").session(session).contentType("application/json")
        .content("{\"currentPassword\":\"wrong-password\",\"newPassword\":\"new-password-456\"}"))
      .andExpect(status().isBadRequest());
    mvc.perform(post("/admin/password").session(session).contentType("application/json")
        .content("{\"currentPassword\":\"test-password-123\",\"newPassword\":\"new-password-456\"}"))
      .andExpect(status().isOk());
    String hash=jdbc.queryForObject("SELECT password_hash FROM admin_account WHERE username='admin'",String.class);
    assertNotNull(hash);assertTrue(hash.startsWith("$2"));assertNotEquals("new-password-456",hash);
    mvc.perform(post("/auth/login").param("username","admin").param("password","test-password-123"))
      .andExpect(status().isUnauthorized());
    mvc.perform(post("/auth/login").param("username","admin").param("password","new-password-456"))
      .andExpect(status().isNoContent());
  }
}
