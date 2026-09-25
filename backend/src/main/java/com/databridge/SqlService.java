package com.databridge;

import java.sql.*;
import java.time.*;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeFormatterBuilder;
import java.time.temporal.ChronoField;
import java.util.*;
import java.util.regex.Pattern;
import net.sf.jsqlparser.parser.CCJSqlParserUtil;
import net.sf.jsqlparser.statement.select.Select;
import org.springframework.http.HttpStatus;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

@Service
public class SqlService {
  private static final Logger log=LoggerFactory.getLogger(SqlService.class);
  private static final Pattern FORBIDDEN = Pattern.compile("(?i)\\b(insert|update|delete|merge|drop|create|alter|truncate|call|do|grant|revoke|copy|into|execute|exec|lock)\\b|\\bfor\\s+update\\b");
  private static final DateTimeFormatter TIMESTAMP_FORMAT=new DateTimeFormatterBuilder()
    .appendPattern("uuuu-MM-dd'T'HH:mm:ss").appendFraction(ChronoField.NANO_OF_SECOND,0,9,true).toFormatter();
  private static final DateTimeFormatter TIME_FORMAT=new DateTimeFormatterBuilder()
    .appendPattern("HH:mm:ss").appendFraction(ChronoField.NANO_OF_SECOND,0,9,true).toFormatter();
  private final DatasourceService sources;
  private final Json json;
  public SqlService(DatasourceService sources, Json json) { this.sources=sources; this.json=json; }
  public void validate(String sql) {
    if (sql==null || sql.isBlank()) throw ApiException.bad("SQL is required");
    var scanned=scan(sql,false);
    String bare=scanned.bare();
    if(FORBIDDEN.matcher(bare).find()) throw ApiException.bad("only one read-only SELECT statement is allowed");
    try {
      var statements=CCJSqlParserUtil.parseStatements(scanned.parserSql());
      if(statements.size()!=1 || !(statements.get(0) instanceof Select))
        throw ApiException.bad("only one read-only SELECT statement is allowed");
    } catch(ApiException e) { throw e; }
    catch(Exception e) { throw ApiException.bad("SQL must be one valid SELECT statement"); }
  }
  public List<String> parameterNames(String sql) { return scan(sql,false).names(); }
  private record SqlParts(String bare,String jdbcSql,String parserSql,List<String> names) {}
  private SqlParts scan(String sql,boolean postgresPrepared) {
    StringBuilder bare=new StringBuilder(sql.length());
    StringBuilder jdbcSql=new StringBuilder(sql.length());
    StringBuilder parserSql=new StringBuilder(sql.length());
    var names=new ArrayList<String>();
    for(int i=0;i<sql.length();) {
      char ch=sql.charAt(i);
      if(ch=='-' && i+1<sql.length() && sql.charAt(i+1)=='-' || ch=='/' && i+1<sql.length() && sql.charAt(i+1)=='*')
        throw ApiException.bad("SQL comments are not allowed");
      String delimiter=null;
      if(ch=='\'' || ch=='"' || ch=='`') delimiter=String.valueOf(ch);
      else if(ch=='$') {
        int end=sql.indexOf('$',i+1);
        if(end>i && sql.substring(i+1,end).matches("[A-Za-z_][A-Za-z0-9_]*") || end==i+1)
          delimiter=sql.substring(i,end+1);
      }
      if(delimiter!=null) {
        int start=i;i+=delimiter.length();
        boolean backslashEscapes=ch=='\'' && i>=2 && (sql.charAt(start-1)=='E' || sql.charAt(start-1)=='e')
          && (start==1 || !Character.isLetterOrDigit(sql.charAt(start-2)) && sql.charAt(start-2)!='_');
        boolean closed=false;
        while(i<sql.length()) {
          if(backslashEscapes && sql.charAt(i)=='\\' && i+1<sql.length()) { i+=2;continue; }
          if(sql.startsWith(delimiter,i)) {
            i+=delimiter.length();
            if(delimiter.length()==1 && i<sql.length() && sql.startsWith(delimiter,i)) { i++; continue; }
            closed=true;break;
          }
          i++;
        }
        if(!closed) throw ApiException.bad("SQL string is not closed");
        bare.append(" ".repeat(i-start));
        jdbcSql.append(sql,start,i);
        if(backslashEscapes) {
          parserSql.setLength(parserSql.length()-1);
          parserSql.append("'x'");
        } else parserSql.append(sql,start,i);
      } else if(ch==':' && i+1<sql.length() && sql.charAt(i+1)==':') {
        bare.append("::");jdbcSql.append("::");parserSql.append("::");i+=2;
      } else if(ch==':' && i+1<sql.length() && (Character.isLetter(sql.charAt(i+1)) || sql.charAt(i+1)=='_')) {
        int end=i+2;
        while(end<sql.length() && (Character.isLetterOrDigit(sql.charAt(end)) || sql.charAt(end)=='_')) end++;
        names.add(sql.substring(i+1,end));bare.append(" ".repeat(end-i));jdbcSql.append('?');parserSql.append("NULL");i=end;
      } else {
        bare.append(ch);jdbcSql.append(ch=='?' && postgresPrepared?"??":String.valueOf(ch));parserSql.append(ch);i++;
      }
    }
    return new SqlParts(bare.toString(),jdbcSql.toString(),parserSql.toString(),List.copyOf(names));
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
  public record QueryResult(List<Map<String,Object>> rows,Set<String> timestampFields) {}
  public List<Map<String,Object>> execute(Map<String,Object> api, Map<String,?> input) {
    return executeResult(api,input).rows();
  }
  public QueryResult executeResult(Map<String,Object> api, Map<String,?> input) {
    String sql=(String)api.get("sqlText"); validate(sql);
    var params=parameters(api.get("paramSchema"),input);
    var source=sources.get(((Number)api.get("datasourceId")).longValue());
    var parsed=scan(sql,"POSTGRESQL".equals(source.get("dbType")));
    for(String name:parsed.names()) if(!params.containsKey(name)) throw ApiException.bad("SQL contains an undeclared parameter: "+name);
    var types=new HashMap<String,Integer>();
    for(var field:json.objects(api.get("paramSchema"))) types.put((String)field.get("name"),jdbcType((String)field.get("type")));
    int max=((Number)api.get("maxRows")).intValue(), timeout=((Number)api.get("timeoutSeconds")).intValue();
    try (Connection connection=sources.pool(((Number)api.get("datasourceId")).longValue()).getConnection()) {
      connection.setReadOnly(true); connection.setAutoCommit(false);
      try (PreparedStatement statement=connection.prepareStatement(parsed.jdbcSql())) {
        statement.setQueryTimeout(timeout); statement.setMaxRows(max+1);
        for (int i=0;i<parsed.names().size();i++) {
          String name=parsed.names().get(i);Object value=params.get(name);
          if(value==null) statement.setNull(i+1,types.get(name));
          else statement.setObject(i+1,value);
        }
        var result=new ArrayList<Map<String,Object>>();
        var timestampFields=new HashSet<String>();
        try (ResultSet rs=statement.executeQuery()) {
          ResultSetMetaData meta=rs.getMetaData();
          var labels=new HashSet<String>();
          for(int i=1;i<=meta.getColumnCount();i++) {
            String label=meta.getColumnLabel(i);
            if(!labels.add(label)) throw ApiException.bad("SQL result contains duplicate column label: "+label);
            if(meta.getColumnType(i)==Types.TIMESTAMP) timestampFields.add(label);
          }
          while (rs.next()) {
            var row=new LinkedHashMap<String,Object>();
            for(int i=1;i<=meta.getColumnCount();i++) {
              String columnType=meta.getColumnTypeName(i).toLowerCase(Locale.ROOT);
              Object value;
              if(columnType.equals("timetz") || meta.getColumnType(i)==Types.TIME_WITH_TIMEZONE)
                value=rs.getObject(i,OffsetTime.class);
              else if(columnType.equals("timestamptz") || meta.getColumnType(i)==Types.TIMESTAMP_WITH_TIMEZONE)
                value=rs.getObject(i,OffsetDateTime.class);
              else if(meta.getColumnType(i)==Types.TIME) value=rs.getObject(i,LocalTime.class);
              else value=rs.getObject(i);
              row.put(meta.getColumnLabel(i),normalizeJdbcValue(value));
            }
            result.add(row);
            if (result.size()>max) throw new ApiException(50023,HttpStatus.UNPROCESSABLE_ENTITY,"query exceeded maximum rows");
          }
        }
        return new QueryResult(result,Set.copyOf(timestampFields));
      } finally { connection.rollback(); }
    } catch (ApiException e) { throw e; }
    catch (SQLTimeoutException e) { log.warn("data source query timed out (SQLState {})",e.getSQLState()); throw new ApiException(50022,HttpStatus.GATEWAY_TIMEOUT,"data source query timed out"); }
    catch (SQLException e) {
      if ("57014".equals(e.getSQLState())) { log.warn("data source query timed out (SQLState {})",e.getSQLState()); throw new ApiException(50022,HttpStatus.GATEWAY_TIMEOUT,"data source query timed out"); }
      log.error("data source SQL execution failed (SQLState {}, exception {})",e.getSQLState(),e.getClass().getSimpleName());
      throw new ApiException(50021,HttpStatus.BAD_GATEWAY,"data source query failed");
    }
    catch (RuntimeException e) { log.error("data source connection failed (exception {})",e.getClass().getSimpleName()); throw new ApiException(50011,HttpStatus.BAD_GATEWAY,"data source connection failed"); }
  }
  private int jdbcType(String type) {
    return switch(type) {
      case "string" -> Types.VARCHAR;
      case "integer" -> Types.BIGINT;
      case "decimal" -> Types.NUMERIC;
      case "boolean" -> Types.BOOLEAN;
      case "date" -> Types.DATE;
      case "datetime" -> Types.TIMESTAMP;
      default -> throw ApiException.bad("invalid parameter type");
    };
  }
  private Object normalizeJdbcValue(Object value) throws SQLException {
    if(value==null) return null;
    if(value instanceof LocalTime time) return TIME_FORMAT.format(time);
    if(value instanceof OffsetTime time) return TIME_FORMAT.format(time.toLocalTime())+time.getOffset().toString();
    if(value instanceof OffsetDateTime datetime) return datetime.toString();
    if(value instanceof Timestamp timestamp) return TIMESTAMP_FORMAT.format(timestamp.toLocalDateTime());
    if(value instanceof LocalDateTime datetime) return TIMESTAMP_FORMAT.format(datetime);
    if(value instanceof java.sql.Date date) return date.toLocalDate().toString();
    if(value instanceof org.postgresql.util.PGobject pg)
      return "json".equalsIgnoreCase(pg.getType()) || "jsonb".equalsIgnoreCase(pg.getType()) ? json.read(pg.getValue()) : pg.getValue();
    if(value instanceof java.sql.Array array) {
      try { return normalizeJdbcValue(array.getArray()); }
      finally { array.free(); }
    }
    if(value instanceof java.sql.SQLXML xml) {
      try { return xml.getString(); }
      finally { xml.free(); }
    }
    if(value instanceof java.sql.Clob clob) {
      try (var reader=clob.getCharacterStream()) {
        var writer=new java.io.StringWriter();reader.transferTo(writer);return writer.toString();
      } catch(java.io.IOException e) { throw new SQLException("could not read SQL CLOB",e); }
      finally { clob.free(); }
    }
    if(value instanceof java.sql.Blob blob) {
      try {
        if(blob.length()>Integer.MAX_VALUE) throw new SQLException("SQL BLOB is too large");
        return Base64.getEncoder().encodeToString(blob.getBytes(1,(int)blob.length()));
      } finally { blob.free(); }
    }
    if(value instanceof java.sql.Struct struct) return normalizeJdbcValue(struct.getAttributes());
    if(value.getClass().isArray() && !(value instanceof byte[])) {
      var result=new ArrayList<Object>();
      for(int i=0;i<java.lang.reflect.Array.getLength(value);i++) result.add(normalizeJdbcValue(java.lang.reflect.Array.get(value,i)));
      return result;
    }
    return value;
  }
}
