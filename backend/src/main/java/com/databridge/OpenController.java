package com.databridge;

import jakarta.servlet.http.HttpServletRequest;
import java.util.*;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
public class OpenController {
  private static final Logger log=LoggerFactory.getLogger(OpenController.class);
  private final PlatformRepository repo;
  private final ApiService apis;
  private final SecurityConfig security;
  private final Json json;
  public OpenController(PlatformRepository repo,ApiService apis,SecurityConfig security,Json json) {this.repo=repo;this.apis=apis;this.security=security;this.json=json;}
  @RequestMapping("/open/**")
  public ResponseEntity<Map<String,Object>> dispatch(HttpServletRequest request,@RequestHeader(value="X-API-Key",required=false) String key,
                                                      @RequestBody(required=false) Map<String,Object> body) {
    String requestId=UUID.randomUUID().toString();request.setAttribute("requestId",requestId);
    var startedAt=java.sql.Timestamp.from(java.time.Instant.now());
    long start=System.nanoTime();Long apiId=null;String mode=null;int count=0;boolean success=false;String error=null;
    try {
      var api=repo.api(request.getRequestURI().substring(request.getContextPath().length()),request.getMethod());
      apiId=((Number)api.get("id")).longValue();mode=(String)api.get("dataMode");
      if("API_KEY".equals(api.get("authMode")) && !security.validApiKey(key))
        throw new ApiException(40101,HttpStatus.UNAUTHORIZED,"invalid API key");
      if(!UserAgentPolicy.allows(json.strings(api.get("allowedUserAgents")),request.getHeader("User-Agent")))
        throw new ApiException(40301,HttpStatus.FORBIDDEN,"User-Agent is not allowed");
      var params=new LinkedHashMap<String,Object>();
      request.getParameterMap().forEach((name,values)->params.put(name,values.length==0?"":values[0]));
      if(body!=null) params.putAll(body);
      var data=apis.query(api,params);count=data.size();
      var meta=new LinkedHashMap<String,Object>();meta.put("count",count);meta.put("source",mode);meta.put("request_id",requestId);
      if("SNAPSHOT".equals(mode)) meta.put("last_sync_time",api.get("lastSyncAt"));
      success=true;
      return ResponseEntity.ok().header("X-Request-ID",requestId).body(Map.of("code",0,"message","success","data",data,"meta",meta));
    } catch(RuntimeException e) {
      error=e instanceof ApiException ? e.getMessage() : "internal server error";
      log.warn("open request {} failed: {}",requestId,e.getMessage());
      throw e;
    } finally {
      try { repo.log(requestId,startedAt,apiId,(System.nanoTime()-start)/1_000_000,count,success,error,mode); }
      catch(Exception e) { log.error("failed to save request log {}",requestId,e); }
    }
  }
}
