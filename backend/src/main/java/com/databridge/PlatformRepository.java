package com.databridge;

import java.sql.PreparedStatement;
import java.sql.Timestamp;
import java.util.*;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.stereotype.Repository;

@Repository
public class PlatformRepository {
  final JdbcTemplate jdbc;
  private final Json json;
  public PlatformRepository(JdbcTemplate jdbc, Json json) { this.jdbc = jdbc; this.json = json; }
  public JdbcTemplate jdbc() { return jdbc; }
  public List<Map<String,Object>> datasources() { return rows("SELECT * FROM datasource ORDER BY id DESC"); }
  public Map<String,Object> datasource(long id) { return one("SELECT * FROM datasource WHERE id=?", id); }
  public List<Map<String,Object>> apis() { return rows("SELECT * FROM api_config ORDER BY id DESC"); }
  public Map<String,Object> api(long id) { return one("SELECT * FROM api_config WHERE id=?", id); }
  public Map<String,Object> lockedApi(long id) { return one("SELECT * FROM api_config WHERE id=? FOR UPDATE", id); }
  public Map<String,Object> api(String path, String method) {
    return one("SELECT * FROM api_config WHERE path=? AND http_method=? AND enabled=true", path, method);
  }
  public List<Map<String,Object>> scheduledApis() {
    return rows("SELECT * FROM api_config WHERE data_mode='SNAPSHOT' AND enabled=true AND sync_cron IS NOT NULL");
  }
  private Map<String,Object> one(String sql, Object... args) {
    try { return convert(jdbc.queryForMap(sql, args)); }
    catch (EmptyResultDataAccessException e) { throw ApiException.missing("resource not found"); }
  }
  private List<Map<String,Object>> rows(String sql, Object... args) { return jdbc.queryForList(sql, args).stream().map(this::convert).toList(); }
  private Map<String,Object> convert(Map<String,Object> source) {
    var result = new LinkedHashMap<String,Object>();
    source.forEach((key, value) -> {
      String camel = java.util.regex.Pattern.compile("_([a-z])").matcher(key).replaceAll(m -> m.group(1).toUpperCase());
      if (value instanceof org.postgresql.util.PGobject pg && "jsonb".equals(pg.getType())) {
        value = json.read(pg.getValue());
      }
      result.put(camel, value);
    });
    return result;
  }
  public long insert(String sql, Object... args) {
    var holder = new GeneratedKeyHolder();
    jdbc.update(connection -> {
      PreparedStatement statement = connection.prepareStatement(sql, new String[]{"id"});
      for (int i=0; i<args.length; i++) statement.setObject(i+1, args[i]);
      return statement;
    }, holder);
    return Objects.requireNonNull(holder.getKey()).longValue();
  }
  public void replaceSnapshot(long apiId, List<Map<String,Object>> data, List<String> keys,Set<String> timestampFields) {
    var oldSort=new HashMap<String,Integer>();
    for(var entry:jdbc.query("SELECT row_key,sort_no FROM api_row_sort WHERE api_id=?",
        (rs,n)->Map.entry(rs.getString(1),rs.getInt(2)),apiId)) oldSort.put(entry.getKey(),entry.getValue());
    jdbc.update("DELETE FROM api_data_row WHERE api_id=?", apiId);
    record SnapshotRow(String key,String value,int order,Integer migratedSortNo) {}
    var batch=new ArrayList<SnapshotRow>(data.size());
    for(int i=0;i<data.size();i++) {
      var row=data.get(i);
      String key=RowKeys.key(row,keys,json);
      Integer migratedSortNo=null;
      if(!oldSort.containsKey(key)) {
        String legacyKey=RowKeys.legacyTimestampKey(row,keys,timestampFields,json);
        if(legacyKey!=null) migratedSortNo=oldSort.get(legacyKey);
      }
      batch.add(new SnapshotRow(key,json.write(row),i,migratedSortNo));
    }
    jdbc.batchUpdate("INSERT INTO api_data_row(api_id,row_key,data_json,source_order) VALUES(?,?,?::jsonb,?)",batch,500,(statement,row)->{
      statement.setLong(1,apiId);statement.setString(2,row.key());statement.setString(3,row.value());statement.setInt(4,row.order());
    });
    var migrated=batch.stream().filter(row->row.migratedSortNo()!=null).toList();
    jdbc.batchUpdate("INSERT INTO api_row_sort(api_id,row_key,sort_no) VALUES(?,?,?) ON CONFLICT(api_id,row_key) DO UPDATE SET sort_no=excluded.sort_no",
      migrated,500,(statement,row)->{
        statement.setLong(1,apiId);statement.setString(2,row.key());statement.setInt(3,row.migratedSortNo());
      });
    jdbc.update("DELETE FROM api_row_sort s WHERE s.api_id=? AND NOT EXISTS (SELECT 1 FROM api_data_row d WHERE d.api_id=s.api_id AND d.row_key=s.row_key)", apiId);
  }
  public List<Map<String,Object>> dataRows(long apiId, Map<String,Object> filters, int maxRows) {
    String sql = "SELECT d.row_key,d.data_json,d.source_order,s.sort_no FROM api_data_row d LEFT JOIN api_row_sort s ON s.api_id=d.api_id AND s.row_key=d.row_key WHERE d.api_id=?";
    var params = new ArrayList<Object>(); params.add(apiId);
    if (!filters.isEmpty()) { sql += " AND d.data_json @> ?::jsonb"; params.add(json.write(filters)); }
    sql += " ORDER BY CASE WHEN s.sort_no IS NULL THEN 1 ELSE 0 END,s.sort_no,d.source_order,d.id LIMIT ?";
    params.add(maxRows + 1);
    return rows(sql, params.toArray());
  }
  public List<Map<String,Object>> adminDataRows(long apiId) {
    return adminDataRows(apiId,null,null);
  }
  public List<Map<String,Object>> adminDataRows(long apiId,Integer offset,Integer limit) {
    String sql="SELECT d.row_key,d.row_version,d.data_json,d.source_order,s.sort_no FROM api_data_row d LEFT JOIN api_row_sort s ON s.api_id=d.api_id AND s.row_key=d.row_key WHERE d.api_id=? ORDER BY CASE WHEN s.sort_no IS NULL THEN 1 ELSE 0 END,s.sort_no,d.source_order,d.id";
    if(offset==null || limit==null) return rows(sql,apiId);
    return rows(sql+" LIMIT ? OFFSET ?",apiId,limit,offset);
  }
  public int countRows(long apiId) { return jdbc.queryForObject("SELECT count(*) FROM api_data_row WHERE api_id=?", Integer.class, apiId); }
  public void log(String requestId, Timestamp startedAt, Long apiId, long elapsedMs, int count, boolean success, String error, String source) {
    jdbc.update("INSERT INTO api_request_log(request_id,request_time,api_id,elapsed_ms,row_count,success,error_message,data_source) VALUES(?,?,?,?,?,?,?,?)",
      requestId, startedAt, apiId, Math.min(elapsedMs, Integer.MAX_VALUE), count, success, error, source);
  }
  public List<Map<String,Object>> logs(Long apiId, Boolean success, Timestamp from, Timestamp to) {
    String sql = "SELECT * FROM api_request_log WHERE (?::bigint IS NULL OR api_id=?) AND (?::boolean IS NULL OR success=?) AND (?::timestamp IS NULL OR request_time>=?) AND (?::timestamp IS NULL OR request_time<=?) ORDER BY request_time DESC LIMIT 500";
    return rows(sql, apiId, apiId, success, success, from, from, to, to);
  }
}
