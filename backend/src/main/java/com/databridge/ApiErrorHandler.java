package com.databridge;

import jakarta.servlet.http.HttpServletRequest;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

@RestControllerAdvice
public class ApiErrorHandler {
  private static final Logger log=LoggerFactory.getLogger(ApiErrorHandler.class);
  @ExceptionHandler(ApiException.class)
  public ResponseEntity<Map<String,Object>> api(ApiException e,HttpServletRequest request) {
    return ResponseEntity.status(e.status).body(Map.of("code",e.code,"message",e.getMessage(),"request_id",requestId(request)));
  }
  @ExceptionHandler(Exception.class)
  public ResponseEntity<Map<String,Object>> unexpected(Exception e,HttpServletRequest request) {
    log.error("request {} failed",requestId(request),e);
    if(e instanceof DataIntegrityViolationException) return ResponseEntity.status(HttpStatus.CONFLICT).body(Map.of("code",40901,"message","data conflict","request_id",requestId(request)));
    return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(Map.of("code",50000,"message","internal server error","request_id",requestId(request)));
  }
  private String requestId(HttpServletRequest request) {
    Object id=request.getAttribute("requestId");return id==null?java.util.UUID.randomUUID().toString():String.valueOf(id);
  }
}
