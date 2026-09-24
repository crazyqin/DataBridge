package com.databridge;

import org.springframework.http.HttpStatus;

public class ApiException extends RuntimeException {
  public final int code;
  public final HttpStatus status;
  public ApiException(int code, HttpStatus status, String message) { super(message); this.code = code; this.status = status; }
  public static ApiException bad(String message) { return new ApiException(40001, HttpStatus.BAD_REQUEST, message); }
  public static ApiException missing(String message) { return new ApiException(40401, HttpStatus.NOT_FOUND, message); }
  public static ApiException conflict(String message) { return new ApiException(40901, HttpStatus.CONFLICT, message); }
}
