package com.databridge;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.LocalDateTime;
import java.time.format.DateTimeParseException;
import java.util.*;

public final class RowKeys {
  private RowKeys() {}
  public static String key(Map<String,Object> row, List<String> fields, Json json) {
    var identity = new LinkedHashMap<String,Object>();
    for (String field : fields) {
      Object value = row.get(field);
      if (value == null) throw ApiException.bad("unique key field is missing or null: " + field);
      identity.put(field, value);
    }
    try {
      byte[] hash = MessageDigest.getInstance("SHA-256").digest(json.write(identity).getBytes(StandardCharsets.UTF_8));
      return HexFormat.of().formatHex(hash);
    } catch (Exception e) { throw new IllegalStateException(e); }
  }
  public static String legacyTimestampKey(Map<String,Object> row,List<String> fields,Set<String> timestampFields,Json json) {
    var legacy=new LinkedHashMap<String,Object>(row);
    boolean changed=false;
    for(String field:fields) {
      if(!timestampFields.contains(field)) continue;
      Object value=row.get(field);
      if(value instanceof String timestamp) {
        try {
          String oldFormat;
          try { oldFormat=LocalDateTime.parse(timestamp).toString(); }
          catch(DateTimeParseException offsetTime) { oldFormat=java.time.OffsetDateTime.parse(timestamp).toLocalDateTime().toString(); }
          if(!oldFormat.equals(timestamp)) { legacy.put(field,oldFormat);changed=true; }
        } catch(DateTimeParseException ignored) { }
      }
    }
    return changed?key(legacy,fields,json):null;
  }
}
