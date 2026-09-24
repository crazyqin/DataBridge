package com.databridge;

import java.sql.Timestamp;
import java.time.LocalDateTime;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.locks.ReentrantLock;
import org.springframework.context.event.EventListener;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;
import org.springframework.scheduling.support.CronExpression;
import org.springframework.scheduling.support.CronTrigger;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterUtils;

@Service
public class ApiService {
  private final PlatformRepository repo;
  private final DatasourceService sources;
  private final SqlService sql;
  private final Json json;
  private final TransactionTemplate tx;
  private final ThreadPoolTaskScheduler scheduler;
  private final Map<Long,ScheduledFuture<?>> tasks=new ConcurrentHashMap<>();
  private final Map<Long,ReentrantLock> locks=new ConcurrentHashMap<>();
  public ApiService(PlatformRepository repo, DatasourceService sources, SqlService sql, Json json,
                    TransactionTemplate tx, ThreadPoolTaskScheduler scheduler) {
    this.repo=repo;this.sources=sources;this.sql=sql;this.json=json;this.tx=tx;this.scheduler=scheduler;
  }
  public List<Map<String,Object>> list() { return repo.apis(); }
  public Map<String,Object> get(long id) { return repo.api(id); }
  private String required(Map<String,Object> body,String key) {
    Object value=body.get(key); if(value==null||String.valueOf(value).isBlank()) throw ApiException.bad(key+" is required");
    return String.valueOf(value).trim();
  }
  private int number(Map<String,Object> body,String key,int fallback,int max) {
    Object value=body.getOrDefault(key,fallback);
    try { int n=Integer.parseInt(String.valueOf(value)); if(n<1||n>max) throw new NumberFormatException(); return n; }
    catch (NumberFormatException e) { throw ApiException.bad(key+" must be between 1 and "+max); }
  }
  @Transactional public Map<String,Object> save(Long id,Map<String,Object> body) {
    String name=required(body,"name"), code=required(body,"code"), path=required(body,"path");
    if(!code.matches("[A-Za-z][A-Za-z0-9_]*")) throw ApiException.bad("invalid API code");
    if(!path.matches("/open(?:/[A-Za-z0-9_-]+)+") || path.length()>300) throw ApiException.bad("path must be under /open");
    String method=String.valueOf(body.getOrDefault("httpMethod","GET")).toUpperCase(Locale.ROOT);
    if(!List.of("GET","POST").contains(method)) throw ApiException.bad("request method must be GET or POST");
    String authMode=String.valueOf(body.getOrDefault("authMode","API_KEY")).toUpperCase(Locale.ROOT);
    if(!List.of("PUBLIC","API_KEY").contains(authMode)) throw ApiException.bad("invalid API access mode");
    String mode=required(body,"dataMode").toUpperCase(Locale.ROOT);
    if(!List.of("REALTIME","SNAPSHOT","MANUAL").contains(mode)) throw ApiException.bad("invalid data mode");
    Long datasourceId=null; String statement=null, cron=null;
    if(!mode.equals("MANUAL")) {
      try { datasourceId=Long.valueOf(String.valueOf(body.get("datasourceId"))); }
      catch(Exception e) { throw ApiException.bad("datasourceId is required"); }
      sources.get(datasourceId);
      statement=required(body,"sqlText"); sql.validate(statement);
    }
    var params=json.objects(body.get("paramSchema"));
    var manual=json.objects(body.get("manualSchema"));
    var filters=json.strings(body.get("filterFields"));
    var keys=json.strings(body.get("rowKeyFields"));
    var userAgents=json.strings(body.get("allowedUserAgents")).stream().map(String::trim).filter(value -> !value.isEmpty()).distinct().toList();
    if(userAgents.size()>20 || userAgents.stream().anyMatch(value -> value.length()>512 || value.equals("*") ||
      value.indexOf('*')>=0 && value.indexOf('*')!=value.length()-1 || value.chars().anyMatch(ch -> Character.isISOControl(ch))))
      throw ApiException.bad("invalid User-Agent allowlist");
    validateSchema(params);validateSchema(manual);
    if(mode.equals("MANUAL") && manual.isEmpty()) throw ApiException.bad("manual fields are required");
    if(mode.equals("SNAPSHOT")) {
      if(keys.isEmpty() || keys.stream().anyMatch(k->!k.matches("[A-Za-z][A-Za-z0-9_]*")) || new HashSet<>(keys).size()!=keys.size())
        throw ApiException.bad("valid unique key fields are required");
      cron=required(body,"syncCron");
      try { CronExpression.parse(cron); } catch(Exception e) { throw ApiException.bad("invalid cron expression"); }
      if(params.stream().anyMatch(p -> Boolean.TRUE.equals(p.get("required")))) throw ApiException.bad("snapshot SQL cannot require request parameters");
      try { NamedParameterUtils.buildValueArray(NamedParameterUtils.parseSqlStatement(statement),new MapSqlParameterSource(),null); }
      catch(Exception e) { throw ApiException.bad("snapshot SQL cannot contain request parameters"); }
    }
    for(String field:filters) if(!field.matches("[A-Za-z][A-Za-z0-9_]*")) throw ApiException.bad("invalid filter field");
    int timeout=number(body,"timeoutSeconds",10,120), max=number(body,"maxRows",10000,100000);
    boolean empty=Boolean.TRUE.equals(body.get("allowEmptySync")), enabled=Boolean.TRUE.equals(body.get("enabled"));
    try {
      if(id==null) id=repo.insert("INSERT INTO api_config(name,code,path,http_method,data_mode,datasource_id,sql_text,param_schema,manual_schema,filter_fields,row_key_fields,sync_cron,allow_empty_sync,timeout_seconds,max_rows,enabled,auth_mode,allowed_user_agents) VALUES(?,?,?,?,?,?,?,?::jsonb,?::jsonb,?::jsonb,?::jsonb,?,?,?,?,?,?,?::jsonb)",
        name,code,path,method,mode,datasourceId,statement,json.write(params),json.write(manual),json.write(filters),json.write(keys),cron,empty,timeout,max,enabled,authMode,json.write(userAgents));
      else {
        String oldMode=(String)repo.api(id).get("dataMode");
        repo.jdbc().update("UPDATE api_config SET name=?,code=?,path=?,http_method=?,data_mode=?,datasource_id=?,sql_text=?,param_schema=?::jsonb,manual_schema=?::jsonb,filter_fields=?::jsonb,row_key_fields=?::jsonb,sync_cron=?,allow_empty_sync=?,timeout_seconds=?,max_rows=?,enabled=?,auth_mode=?,allowed_user_agents=?::jsonb,updated_at=now() WHERE id=?",
          name,code,path,method,mode,datasourceId,statement,json.write(params),json.write(manual),json.write(filters),json.write(keys),cron,empty,timeout,max,enabled,authMode,json.write(userAgents),id);
        if(!oldMode.equals(mode)) {
          repo.jdbc().update("DELETE FROM api_row_sort WHERE api_id=?",id);
          repo.jdbc().update("DELETE FROM api_data_row WHERE api_id=?",id);
          repo.jdbc().update("UPDATE api_config SET last_sync_at=NULL,last_sync_status=NULL,last_sync_count=NULL,last_sync_error=NULL WHERE id=?",id);
        }
      }
    } catch(DataIntegrityViolationException e) { throw ApiException.conflict("API code or path already exists"); }
    long savedId=id;
    TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
      @Override public void afterCommit() { refresh(savedId); }
    });
    return get(id);
  }
  private void validateSchema(List<Map<String,Object>> fields) {
    var names=new HashSet<String>();
    for(var field:fields) {
      String name=String.valueOf(field.get("name")), type=String.valueOf(field.get("type"));
      if(!name.matches("[A-Za-z][A-Za-z0-9_]*") || !names.add(name) || !List.of("string","integer","decimal","boolean","date","datetime").contains(type))
        throw ApiException.bad("invalid or duplicate field definition");
    }
  }
  public void delete(long id) {
    repo.api(id); cancel(id);
    repo.jdbc().update("DELETE FROM api_config WHERE id=?",id);
  }
  public Map<String,Object> enable(long id,boolean enabled) {
    repo.api(id);repo.jdbc().update("UPDATE api_config SET enabled=?,updated_at=now() WHERE id=?",enabled,id);refresh(id);return get(id);
  }
  @EventListener(ApplicationReadyEvent.class) public void startSchedules() {
    for(var api:repo.scheduledApis()) refresh(((Number)api.get("id")).longValue());
  }
  private void cancel(long id) { var task=tasks.remove(id);if(task!=null) task.cancel(false); }
  private void refresh(long id) {
    cancel(id); var api=repo.api(id);
    if("SNAPSHOT".equals(api.get("dataMode")) && Boolean.TRUE.equals(api.get("enabled"))) {
      String cron=(String)api.get("syncCron");
      var task=scheduler.schedule(() -> { try { sync(id); } catch(Exception e) { /* status saved by sync */ } },new CronTrigger(cron));
      if(task!=null) tasks.put(id,task);
    }
  }
  public Map<String,Object> test(long id,Map<String,Object> params) {
    var api=get(id);
    if("MANUAL".equals(api.get("dataMode"))) throw ApiException.bad("manual API has no SQL");
    long start=System.nanoTime();var data=sql.execute(api,params);
    return Map.of("elapsedMs",(System.nanoTime()-start)/1_000_000,"count",data.size(),"data",data);
  }
  public Map<String,Object> sync(long id) {
    var lock=locks.computeIfAbsent(id,k->new ReentrantLock());
    if(!lock.tryLock()) throw ApiException.conflict("this API is already syncing");
    try {
      var api=get(id);
      if(!"SNAPSHOT".equals(api.get("dataMode"))) throw ApiException.bad("API is not SNAPSHOT");
      List<Map<String,Object>> data=sql.execute(api,Map.of());
      if(data.isEmpty() && !Boolean.TRUE.equals(api.get("allowEmptySync"))) throw ApiException.bad("sync result is empty; previous snapshot preserved");
      List<String> keys=json.strings(api.get("rowKeyFields"));
      var unique=new HashSet<String>();
      for(var row:data) if(!unique.add(RowKeys.key(row,keys,json))) throw ApiException.bad("duplicate snapshot unique key");
      tx.executeWithoutResult(status -> {
        repo.replaceSnapshot(id,data,keys);
        repo.jdbc().update("UPDATE api_config SET last_sync_at=now(),last_sync_status='SUCCESS',last_sync_count=?,last_sync_error=NULL WHERE id=?",data.size(),id);
      });
      return Map.of("count",data.size(),"status","SUCCESS");
    } catch(Exception e) {
      repo.jdbc().update("UPDATE api_config SET last_sync_status='FAILED',last_sync_error=? WHERE id=?",e.getMessage(),id);
      throw e;
    } finally { lock.unlock(); }
  }
  public List<Map<String,Object>> rows(long id) {
    var api=get(id);if("REALTIME".equals(api.get("dataMode"))) throw ApiException.bad("realtime API has no local rows");
    return repo.dataRows(id,Map.of(),((Number)api.get("maxRows")).intValue());
  }
  public void sort(long id,List<Map<String,Object>> order) {
    var api=get(id);if(!"SNAPSHOT".equals(api.get("dataMode"))) throw ApiException.bad("sorting requires SNAPSHOT mode");
    var lock=locks.computeIfAbsent(id,k->new ReentrantLock());
    if(!lock.tryLock()) throw ApiException.conflict("this API is already syncing");
    try {
    if(order.size()!=repo.countRows(id)) throw ApiException.bad("sort list must include every row");
    var keys=new HashSet<String>();var numbers=new HashSet<Integer>();
    for(var item:order) {
      String key=String.valueOf(item.get("rowKey"));
      int no;try { no=Integer.parseInt(String.valueOf(item.get("sortNo"))); } catch(Exception e) { throw ApiException.bad("invalid sort number"); }
      if(no<1||!keys.add(key)||!numbers.add(no)) throw ApiException.bad("duplicate or invalid sorting");
    }
    tx.executeWithoutResult(status -> {
      repo.jdbc().update("DELETE FROM api_row_sort WHERE api_id=?",id);
      for(var item:order) {
        int changed=repo.jdbc().update("INSERT INTO api_row_sort(api_id,row_key,sort_no) SELECT ?,d.row_key,? FROM api_data_row d WHERE d.api_id=? AND d.row_key=?",
          id,Integer.parseInt(String.valueOf(item.get("sortNo"))),id,String.valueOf(item.get("rowKey")));
        if(changed!=1) throw ApiException.bad("row disappeared while sorting");
      }
    });
    } finally { lock.unlock(); }
  }
  public void resetSort(long id) {
    if(!"SNAPSHOT".equals(get(id).get("dataMode"))) throw ApiException.bad("sorting requires SNAPSHOT mode");
    repo.jdbc().update("DELETE FROM api_row_sort WHERE api_id=?",id);
  }
  public Map<String,Object> manualCreate(long id,Map<String,Object> input) {
    var api=manualApi(id);var data=validateManual(api,input);
    String key=UUID.randomUUID().toString();
    repo.jdbc().update("INSERT INTO api_data_row(api_id,row_key,data_json,source_order) VALUES(?,?,?::jsonb,(SELECT COALESCE(max(source_order),-1)+1 FROM api_data_row WHERE api_id=?))",id,key,json.write(data),id);
    return Map.of("rowKey",key,"dataJson",data);
  }
  public Map<String,Object> manualUpdate(long id,String key,Map<String,Object> input) {
    var api=manualApi(id);var data=validateManual(api,input);
    if(repo.jdbc().update("UPDATE api_data_row SET data_json=?::jsonb,updated_at=now() WHERE api_id=? AND row_key=?",json.write(data),id,key)==0) throw ApiException.missing("row not found");
    return Map.of("rowKey",key,"dataJson",data);
  }
  public void manualDelete(long id,String key) {
    manualApi(id);if(repo.jdbc().update("DELETE FROM api_data_row WHERE api_id=? AND row_key=?",id,key)==0) throw ApiException.missing("row not found");
  }
  private Map<String,Object> manualApi(long id) {
    var api=get(id);if(!"MANUAL".equals(api.get("dataMode"))) throw ApiException.bad("API is not MANUAL");return api;
  }
  private Map<String,Object> validateManual(Map<String,Object> api,Map<String,Object> input) {
    var data=new LinkedHashMap<String,Object>();
    for(var field:json.objects(api.get("manualSchema"))) {
      String name=String.valueOf(field.get("name"));Object value=input.get(name);
      if(value==null && Boolean.TRUE.equals(field.get("required"))) throw ApiException.bad("missing field: "+name);
      data.put(name,value==null?null:sql.convert(value,String.valueOf(field.get("type"))));
    }
    if(input.keySet().stream().anyMatch(k->!data.containsKey(k))) throw ApiException.bad("undeclared manual field");
    return data;
  }
  public List<Map<String,Object>> query(Map<String,Object> api,Map<String,?> input) {
    if("REALTIME".equals(api.get("dataMode"))) return sql.execute(api,input);
    var fields=json.strings(api.get("filterFields"));var filters=new LinkedHashMap<String,Object>();
    for(var item:input.entrySet()) {
      if(!fields.contains(item.getKey())) throw ApiException.bad("filter is not allowed: "+item.getKey());
      String type="string";
      var schema="MANUAL".equals(api.get("dataMode"))?api.get("manualSchema"):api.get("paramSchema");
      for(var field:json.objects(schema)) if(item.getKey().equals(field.get("name"))) type=String.valueOf(field.get("type"));
      filters.put(item.getKey(),sql.convert(item.getValue(),type));
    }
    var rows=repo.dataRows(((Number)api.get("id")).longValue(),filters,((Number)api.get("maxRows")).intValue());
    if(rows.size()>((Number)api.get("maxRows")).intValue()) throw new ApiException(50023,HttpStatus.UNPROCESSABLE_ENTITY,"query exceeded maximum rows");
    return rows.stream().map(row -> (Map<String,Object>)row.get("dataJson")).toList();
  }
  public List<Map<String,Object>> logs(Long apiId,Boolean success,String from,String to) {
    try {
      Timestamp a=from==null?null:Timestamp.valueOf(LocalDateTime.parse(from));
      Timestamp b=to==null?null:Timestamp.valueOf(LocalDateTime.parse(to));
      return repo.logs(apiId,success,a,b);
    } catch(Exception e) { throw ApiException.bad("invalid log time range"); }
  }
}
