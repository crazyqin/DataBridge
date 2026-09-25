package com.databridge;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.*;
import org.springframework.stereotype.Component;

@Component
public class Json {
  private final ObjectMapper mapper;
  public Json(ObjectMapper mapper) {
    this.mapper = mapper;
    mapper.enable(DeserializationFeature.USE_BIG_DECIMAL_FOR_FLOATS);
  }
  public String write(Object value) {
    try { return mapper.writeValueAsString(value); } catch (Exception e) { throw new IllegalArgumentException("invalid JSON", e); }
  }
  public Map<String,Object> map(String value) {
    try { return mapper.readValue(value, new TypeReference<>() {}); } catch (Exception e) { throw ApiException.bad("invalid JSON data"); }
  }
  public Object read(String value) {
    try { return mapper.readValue(value,Object.class); } catch (Exception e) { throw new IllegalStateException("stored JSON invalid",e); }
  }
  public Object adminSafeNumbers(Object value) {
    if(value instanceof java.math.BigDecimal decimal) return decimal.toPlainString();
    if(value instanceof java.math.BigInteger integer && integer.abs().compareTo(java.math.BigInteger.valueOf(9007199254740991L))>0)
      return integer.toString();
    if(value instanceof Long integer && (integer>9007199254740991L || integer< -9007199254740991L)) return integer.toString();
    if(value instanceof Map<?,?> map) {
      var safe=new LinkedHashMap<String,Object>();
      map.forEach((key,item)->safe.put(String.valueOf(key),adminSafeNumbers(item)));
      return safe;
    }
    if(value instanceof List<?> list) return list.stream().map(this::adminSafeNumbers).toList();
    return value;
  }
  public List<Map<String,Object>> objects(Object value) {
    if (value == null) return List.of();
    if (!(value instanceof List<?> list)) throw ApiException.bad("schema must be an array");
    var result = new ArrayList<Map<String,Object>>();
    for (Object item : list) {
      if (!(item instanceof Map<?,?> raw)) throw ApiException.bad("schema entries must be objects");
      var map = new LinkedHashMap<String,Object>();
      raw.forEach((k,v) -> map.put(String.valueOf(k), v));
      result.add(map);
    }
    return result;
  }
  public List<String> strings(Object value) {
    if (value == null) return List.of();
    if (!(value instanceof List<?> list)) throw ApiException.bad("field list must be an array");
    return list.stream().map(String::valueOf).toList();
  }
}
