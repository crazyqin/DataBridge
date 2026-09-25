package com.databridge;

import jakarta.servlet.http.HttpServletRequest;
import java.util.*;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
public class OpenController {
  private static final Logger log=LoggerFactory.getLogger(OpenController.class);
  private final PlatformRepository repo;
  private final OpenQueryService queries;
  public OpenController(PlatformRepository repo,OpenQueryService queries) {this.repo=repo;this.queries=queries;}
  @RequestMapping("/open/**")
  public ResponseEntity<Map<String,Object>> dispatch(HttpServletRequest request,@RequestHeader(value="X-API-Key",required=false) String key,
                                                      @RequestBody(required=false) Map<String,Object> body) {
    String requestId=UUID.randomUUID().toString();request.setAttribute("requestId",requestId);
    var startedAt=java.sql.Timestamp.from(java.time.Instant.now());
    long start=System.nanoTime();int count=0;boolean success=false;String error=null;
    var context=new OpenQueryService.Context();
    try {
      var params=new LinkedHashMap<String,Object>();
      request.getParameterMap().forEach((name,values)->params.put(name,values.length==0?"":values[0]));
      if(body!=null) params.putAll(body);
      var data=queries.query(request.getRequestURI().substring(request.getContextPath().length()),request.getMethod(),
        key,request.getHeader("User-Agent"),params,context);count=data.size();
      var api=context.api;
      long apiId=((Number)api.get("id")).longValue();
      long version=((Number)api.get("configVersion")).longValue();
      if(((Number)repo.api(apiId).get("configVersion")).longValue()!=version)
        throw ApiException.conflict("API configuration changed during request; retry");
      String mode=(String)api.get("dataMode");
      var meta=new LinkedHashMap<String,Object>();meta.put("count",count);meta.put("source",mode);meta.put("request_id",requestId);
      if("SNAPSHOT".equals(mode)) meta.put("last_sync_time",api.get("lastSyncAt"));
      success=true;
      return ResponseEntity.ok().header("X-Request-ID",requestId).body(Map.of("code",0,"message","success","data",data,"meta",meta));
    } catch(RuntimeException e) {
      error=e instanceof ApiException ? e.getMessage() : "internal server error";
      log.warn("open request {} failed: {}",requestId,e.getMessage());
      throw e;
    } finally {
      Long apiId=context.api==null?null:((Number)context.api.get("id")).longValue();
      String mode=context.api==null?null:(String)context.api.get("dataMode");
      try { repo.log(requestId,startedAt,apiId,(System.nanoTime()-start)/1_000_000,count,success,error,mode); }
      catch(Exception e) { log.error("failed to save request log {}",requestId,e); }
    }
  }
}
