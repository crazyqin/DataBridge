package com.databridge;

import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import java.sql.Connection;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;

@Service
public class DatasourceService {
  private final PlatformRepository repo;
  private final CryptoService crypto;
  private final Map<Long,HikariDataSource> pools = new ConcurrentHashMap<>();
  public DatasourceService(PlatformRepository repo, CryptoService crypto) { this.repo=repo; this.crypto=crypto; }
  public List<Map<String,Object>> list() { return repo.datasources().stream().map(this::hidePassword).toList(); }
  public Map<String,Object> get(long id) { return hidePassword(repo.datasource(id)); }
  private Map<String,Object> hidePassword(Map<String,Object> row) {
    var copy = new LinkedHashMap<>(row); copy.remove("passwordEnc"); copy.put("hasPassword", true); return copy;
  }
  private String string(Map<String,Object> data, String key) {
    Object value=data.get(key); if (value==null || String.valueOf(value).isBlank()) throw ApiException.bad(key + " is required");
    return String.valueOf(value).trim();
  }
  private String driver(String type, String url) {
    return switch (type.toUpperCase(Locale.ROOT)) {
      case "POSTGRESQL" -> { if (!url.startsWith("jdbc:postgresql:")) throw ApiException.bad("JDBC URL does not match database type"); yield "org.postgresql.Driver"; }
      case "MYSQL" -> { if (!url.startsWith("jdbc:mysql:")) throw ApiException.bad("JDBC URL does not match database type"); yield "com.mysql.cj.jdbc.Driver"; }
      case "ORACLE" -> { if (!url.startsWith("jdbc:oracle:")) throw ApiException.bad("JDBC URL does not match database type"); yield "oracle.jdbc.OracleDriver"; }
      default -> throw ApiException.bad("unsupported database type");
    };
  }
  public Map<String,Object> save(Long id, Map<String,Object> input) {
    String name=string(input,"name"), type=string(input,"dbType").toUpperCase(Locale.ROOT), url=string(input,"jdbcUrl"), user=string(input,"username");
    String driver=driver(type,url);
    boolean enabled=!Boolean.FALSE.equals(input.get("enabled"));
    String password = input.get("password") == null ? "" : String.valueOf(input.get("password"));
    if (id==null) {
      if (password.isBlank()) throw ApiException.bad("password is required");
      id=repo.insert("INSERT INTO datasource(name,db_type,jdbc_url,driver_class,username,password_enc,enabled) VALUES(?,?,?,?,?,?,?)",
        name,type,url,driver,user,crypto.encrypt(password),enabled);
    } else {
      repo.datasource(id);
      if (password.isBlank()) repo.jdbc().update("UPDATE datasource SET name=?,db_type=?,jdbc_url=?,driver_class=?,username=?,enabled=?,updated_at=now() WHERE id=?",
        name,type,url,driver,user,enabled,id);
      else repo.jdbc().update("UPDATE datasource SET name=?,db_type=?,jdbc_url=?,driver_class=?,username=?,password_enc=?,enabled=?,updated_at=now() WHERE id=?",
        name,type,url,driver,user,crypto.encrypt(password),enabled,id);
      close(id);
    }
    return get(id);
  }
  public void delete(long id) {
    try { if (repo.jdbc().update("DELETE FROM datasource WHERE id=?",id)==0) throw ApiException.missing("data source not found"); }
    catch (DataIntegrityViolationException e) { throw ApiException.conflict("data source is used by an API"); }
    close(id);
  }
  public HikariDataSource pool(long id) {
    return pools.computeIfAbsent(id, key -> {
      Map<String,Object> row=repo.datasource(key);
      if (!Boolean.TRUE.equals(row.get("enabled"))) throw ApiException.bad("data source is disabled");
      var config=new HikariConfig();
      config.setJdbcUrl((String)row.get("jdbcUrl"));
      config.setDriverClassName((String)row.get("driverClass"));
      config.setUsername((String)row.get("username"));
      config.setPassword(crypto.decrypt((String)row.get("passwordEnc")));
      config.setMaximumPoolSize(3); config.setMinimumIdle(0); config.setConnectionTimeout(5000);
      config.setPoolName("source-"+key);
      return new HikariDataSource(config);
    });
  }
  public Map<String,Object> test(long id) {
    long start=System.nanoTime();
    try (Connection connection=pool(id).getConnection()) {
      return Map.of("success",true,"database",connection.getMetaData().getDatabaseProductName(),"elapsedMs",(System.nanoTime()-start)/1_000_000);
    } catch (Exception e) { throw new ApiException(50011,org.springframework.http.HttpStatus.BAD_GATEWAY,"data source connection failed"); }
  }
  private void close(long id) { HikariDataSource pool=pools.remove(id); if (pool!=null) pool.close(); }
  @jakarta.annotation.PreDestroy public void closeAll() { pools.values().forEach(HikariDataSource::close); pools.clear(); }
}
