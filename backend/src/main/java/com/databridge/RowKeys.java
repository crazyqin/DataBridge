package com.databridge;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
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
}
