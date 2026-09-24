package com.databridge;

import java.sql.*;
import java.time.*;
import java.util.*;
import java.util.regex.Pattern;
import org.springframework.http.HttpStatus;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterUtils;
import org.springframework.stereotype.Service;

@Service
public class SqlService {
  private static final Logger log=LoggerFactory.getLogger(SqlService.class);
  private static final Pattern FORBIDDEN = Pattern.compile("(?i)\\b(insert|update|delete|merge|drop|create|alter|truncate|call|do|grant|revoke|copy|into|execute|exec|lock)\\b|\\bfor\\s+update\\b");
  private final DatasourceService sources;
  private final Json json;
  public SqlService(DatasourceService sources, Json json) { this.sources=sources; this.json=json; }
  public void validate(String sql) {
    if (sql==null || sql.isBlank()) throw ApiException.bad("SQL is required");
    StringBuilder bare=new StringBuilder(); boolean quote=false;
    for (int i=0;i<sql.length();i++) {
      char ch=sql.charAt(i);
      if (ch=='\'' ) {
        if (quote && i+1<sql.length() && sql.charAt(i+1)=='\'') { bare.append("  "); i++; continue; }
        quote=!quote; bare.append(' '); continue;
      }
      if (quote) { bare.append(' '); continue; }
      if (ch=='-' && i+1<sql.length() && sql.charAt(i+1)=='-' || ch=='/' && i+1<sql.length() && sql.charAt(i+1)=='*') throw ApiException.bad("SQL comments are not allowed");
      bare.append(ch);
    }
    if (quote) throw ApiException.bad("SQL string is not closed");
    String text=bare.toString().strip();
    if (text.endsWith(";")) text=text.substring(0,text.length()-1).strip();
    if (text.contains(";") || !Pattern.compile("(?is)^(select|with)\\b").matcher(text).find() || FORBIDDEN.matcher(text).find())
      throw ApiException.bad("only one read-only SELECT statement is allowed");
    if (text.regionMatches(true,0,"with",0,4) && !Pattern.compile("(?i)\\bselect\\b").matcher(text).find())
      throw ApiException.bad("WITH must end in SELECT");
  }
  public Map<String,Object> parameters(Object schemaValue, Map<String,?> input) {
    var values=new LinkedHashMap<String,Object>();
    var schema=json.objects(schemaValue);
    for (var field : schema) {
      String name=String.valueOf(field.get("name"));
      if (!name.matches("[A-Za-z][A-Za-z0-9_]*")) throw ApiException.bad("invalid parameter name");
      Object value=input.get(name);
      if (value instanceof String s && s.isBlank()) value=null;
      if (value==null && Boolean.TRUE.equals(field.get("required"))) throw ApiException.bad("missing parameter: "+name);
      if (value!=null) values.put(name, convert(value,String.valueOf(field.get("type"))));
      else values.put(name,null);
    }
    for(String name:input.keySet()) if(!values.containsKey(name)) throw ApiException.bad("undeclared parameter: "+name);
    return values;
  }
  public Object convert(Object value, String type) {
    try {
      return switch(type) {
        case "string" -> String.valueOf(value);
        case "integer" -> Long.valueOf(String.valueOf(value));
        case "decimal" -> new java.math.BigDecimal(String.valueOf(value));
        case "boolean" -> { String s=String.valueOf(value); if (!s.equals("true") && !s.equals("false")) throw new IllegalArgumentException(); yield Boolean.valueOf(s); }
        case "date" -> LocalDate.parse(String.valueOf(value));
        case "datetime" -> LocalDateTime.parse(String.valueOf(value));
        default -> throw new IllegalArgumentException();
      };
    } catch (Exception e) { throw ApiException.bad("invalid " + type + " value"); }
  }
  public List<Map<String,Object>> execute(Map<String,Object> api, Map<String,?> input) {
    String sql=(String)api.get("sqlText"); validate(sql);
    var params=parameters(api.get("paramSchema"),input);
    var parsed=NamedParameterUtils.parseSqlStatement(sql);
    String jdbcSql=NamedParameterUtils.substituteNamedParameters(parsed,new MapSqlParameterSource(params));
    Object[] values;
    try { values=NamedParameterUtils.buildValueArray(parsed,new MapSqlParameterSource(params),null); }
    catch (org.springframework.dao.InvalidDataAccessApiUsageException e) { throw ApiException.bad("SQL contains an undeclared parameter"); }
    int max=((Number)api.get("maxRows")).intValue(), timeout=((Number)api.get("timeoutSeconds")).intValue();
    try (Connection connection=sources.pool(((Number)api.get("datasourceId")).longValue()).getConnection()) {
      connection.setReadOnly(true); connection.setAutoCommit(false);
      try (PreparedStatement statement=connection.prepareStatement(jdbcSql)) {
        statement.setQueryTimeout(timeout); statement.setMaxRows(max+1);
        for (int i=0;i<values.length;i++) statement.setObject(i+1,values[i]);
        var result=new ArrayList<Map<String,Object>>();
        try (ResultSet rs=statement.executeQuery()) {
          ResultSetMetaData meta=rs.getMetaData();
          while (rs.next()) {
            var row=new LinkedHashMap<String,Object>();
            for(int i=1;i<=meta.getColumnCount();i++) {
              Object value=rs.getObject(i);
              if (value instanceof Timestamp t) value=t.toLocalDateTime().toString();
              else if (value instanceof java.sql.Date d) value=d.toLocalDate().toString();
              row.put(meta.getColumnLabel(i),value);
            }
            result.add(row);
            if (result.size()>max) throw new ApiException(50023,HttpStatus.UNPROCESSABLE_ENTITY,"query exceeded maximum rows");
          }
        }
        return result;
      } finally { connection.rollback(); }
    } catch (ApiException e) { throw e; }
    catch (SQLTimeoutException e) { log.warn("data source query timed out",e); throw new ApiException(50022,HttpStatus.GATEWAY_TIMEOUT,"data source query timed out"); }
    catch (SQLException e) {
      if ("57014".equals(e.getSQLState())) { log.warn("data source query timed out",e); throw new ApiException(50022,HttpStatus.GATEWAY_TIMEOUT,"data source query timed out"); }
      log.error("data source SQL execution failed",e);
      throw new ApiException(50021,HttpStatus.BAD_GATEWAY,"data source query failed");
    }
    catch (RuntimeException e) { log.error("data source connection failed",e); throw new ApiException(50011,HttpStatus.BAD_GATEWAY,"data source connection failed"); }
  }
}
