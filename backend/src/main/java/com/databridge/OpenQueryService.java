package com.databridge;

import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

@Service
public class OpenQueryService {
  private final PlatformRepository repo;
  private final ApiService apis;
  private final SecurityConfig security;
  private final Json json;
  private final TransactionTemplate localRead;

  public OpenQueryService(PlatformRepository repo,ApiService apis,SecurityConfig security,Json json,
                          PlatformTransactionManager transactions) {
    this.repo=repo;this.apis=apis;this.security=security;this.json=json;
    this.localRead=new TransactionTemplate(transactions);
    this.localRead.setReadOnly(true);
    this.localRead.setIsolationLevel(Isolation.REPEATABLE_READ.value());
  }

  public static class Context {
    Map<String,Object> api;
  }

  public List<Map<String,Object>> query(String path,String method,String key,String userAgent,
                                         Map<String,Object> params,Context context) {
    var api=repo.api(path,method);
    if("REALTIME".equals(api.get("dataMode"))) return authorizedQuery(api,key,userAgent,params,context);
    return localRead.execute(status -> {
      var current=repo.api(path,method);
      if("REALTIME".equals(current.get("dataMode"))) throw ApiException.conflict("API configuration changed during request; retry");
      return authorizedQuery(current,key,userAgent,params,context);
    });
  }

  private List<Map<String,Object>> authorizedQuery(Map<String,Object> api,String key,String userAgent,
                                                     Map<String,Object> params,Context context) {
    context.api=api;
    if("API_KEY".equals(api.get("authMode")) && !security.validApiKey(key))
      throw new ApiException(40101,HttpStatus.UNAUTHORIZED,"invalid API key");
    if(!UserAgentPolicy.allows(json.strings(api.get("allowedUserAgents")),userAgent))
      throw new ApiException(40301,HttpStatus.FORBIDDEN,"User-Agent is not allowed");
    return apis.query(api,params);
  }
}
