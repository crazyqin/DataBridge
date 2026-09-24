package com.databridge;

import java.util.*;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/admin")
public class AdminController {
  private final DatasourceService sources;
  private final ApiService apis;
  private final AdminAccountService accounts;
  public AdminController(DatasourceService sources,ApiService apis,AdminAccountService accounts) {this.sources=sources;this.apis=apis;this.accounts=accounts;}
  @GetMapping("/session") public Map<String,Object> session(Authentication authentication) {return Map.of("ok",true,"username",authentication.getName());}
  @PostMapping("/password") public Map<String,Object> changePassword(Authentication authentication,@RequestBody Map<String,String> body) {
    accounts.changePassword(authentication.getName(),body.get("currentPassword"),body.get("newPassword"));
    return Map.of("ok",true);
  }
  @GetMapping("/datasources") public List<Map<String,Object>> datasources() {return sources.list();}
  @PostMapping("/datasources") public Map<String,Object> createDatasource(@RequestBody Map<String,Object> body) {return sources.save(null,body);}
  @PutMapping("/datasources/{id}") public Map<String,Object> updateDatasource(@PathVariable long id,@RequestBody Map<String,Object> body) {return sources.save(id,body);}
  @DeleteMapping("/datasources/{id}") @ResponseStatus(HttpStatus.NO_CONTENT) public void deleteDatasource(@PathVariable long id) {sources.delete(id);}
  @PostMapping("/datasources/{id}/test") public Map<String,Object> testDatasource(@PathVariable long id) {return sources.test(id);}
  @GetMapping("/apis") public List<Map<String,Object>> apiList() {return apis.list();}
  @GetMapping("/apis/{id}") public Map<String,Object> api(@PathVariable long id) {return apis.get(id);}
  @PostMapping("/apis") public Map<String,Object> createApi(@RequestBody Map<String,Object> body) {return apis.save(null,body);}
  @PutMapping("/apis/{id}") public Map<String,Object> updateApi(@PathVariable long id,@RequestBody Map<String,Object> body) {return apis.save(id,body);}
  @DeleteMapping("/apis/{id}") @ResponseStatus(HttpStatus.NO_CONTENT) public void deleteApi(@PathVariable long id) {apis.delete(id);}
  @PostMapping("/apis/{id}/enable") public Map<String,Object> enable(@PathVariable long id) {return apis.enable(id,true);}
  @PostMapping("/apis/{id}/disable") public Map<String,Object> disable(@PathVariable long id) {return apis.enable(id,false);}
  @PostMapping("/apis/{id}/test") public Map<String,Object> testApi(@PathVariable long id,@RequestBody(required=false) Map<String,Object> params) {return apis.test(id,params==null?Map.of():params);}
  @PostMapping("/apis/{id}/sync") public Map<String,Object> sync(@PathVariable long id) {return apis.sync(id);}
  @GetMapping("/apis/{id}/rows") public List<Map<String,Object>> rows(@PathVariable long id) {return apis.rows(id);}
  @PutMapping("/apis/{id}/sort") @ResponseStatus(HttpStatus.NO_CONTENT) public void sort(@PathVariable long id,@RequestBody List<Map<String,Object>> order) {apis.sort(id,order);}
  @DeleteMapping("/apis/{id}/sort") @ResponseStatus(HttpStatus.NO_CONTENT) public void resetSort(@PathVariable long id) {apis.resetSort(id);}
  @PostMapping("/apis/{id}/rows") public Map<String,Object> manualCreate(@PathVariable long id,@RequestBody Map<String,Object> body) {return apis.manualCreate(id,body);}
  @PutMapping("/apis/{id}/rows/{key}") public Map<String,Object> manualUpdate(@PathVariable long id,@PathVariable String key,@RequestBody Map<String,Object> body) {return apis.manualUpdate(id,key,body);}
  @DeleteMapping("/apis/{id}/rows/{key}") @ResponseStatus(HttpStatus.NO_CONTENT) public void manualDelete(@PathVariable long id,@PathVariable String key) {apis.manualDelete(id,key);}
  @GetMapping("/logs") public List<Map<String,Object>> logs(@RequestParam(required=false) Long apiId,@RequestParam(required=false) Boolean success,
    @RequestParam(required=false) String from,@RequestParam(required=false) String to) {return apis.logs(apiId,success,from,to);}
}
