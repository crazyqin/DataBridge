package com.databridge;

import java.io.Serializable;
import java.nio.charset.StandardCharsets;
import java.util.Collection;
import java.util.List;
import java.util.regex.Pattern;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.userdetails.UserDetails;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.security.core.userdetails.UsernameNotFoundException;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.stereotype.Service;

@Service
public class AdminAccountService implements UserDetailsService {
  private static final Pattern BCRYPT = Pattern.compile("\\$2[aby]\\$\\d{2}\\$[./A-Za-z0-9]{53}");
  public record AdminUser(String username,String passwordHash) implements UserDetails,Serializable {
    @Override public String getUsername() { return username; }
    @Override public String getPassword() { return passwordHash; }
    @Override public Collection<? extends GrantedAuthority> getAuthorities() { return List.of(new SimpleGrantedAuthority("ROLE_ADMIN")); }
  }
  private final JdbcTemplate jdbc;
  private final BCryptPasswordEncoder encoder;
  private final String initialUsername;
  private final String initialHash;

  public AdminAccountService(JdbcTemplate jdbc, BCryptPasswordEncoder encoder,
                             @Value("${app.admin-username}") String initialUsername,
                             @Value("${app.admin-password-hash}") String initialHash) {
    this.jdbc=jdbc;this.encoder=encoder;this.initialUsername=initialUsername;this.initialHash=initialHash;
  }

  @EventListener(ApplicationReadyEvent.class)
  public void bootstrap() {
    Integer count=jdbc.queryForObject("SELECT count(*) FROM admin_account",Integer.class);
    if(count!=null && count>0) return;
    if(initialUsername.isBlank() || !BCRYPT.matcher(initialHash).matches())
      throw new IllegalStateException("ADMIN_USERNAME and a BCrypt ADMIN_PASSWORD_HASH are required for first startup");
    jdbc.update("INSERT INTO admin_account(username,password_hash) VALUES(?,?)",initialUsername,initialHash);
  }

  @Override public UserDetails loadUserByUsername(String username) throws UsernameNotFoundException {
    try {
      String hash=jdbc.queryForObject("SELECT password_hash FROM admin_account WHERE username=?",String.class,username);
      return new AdminUser(username,hash);
    } catch(EmptyResultDataAccessException e) { throw new UsernameNotFoundException("administrator not found"); }
  }

  public String currentPasswordHash(String username) {
    try { return jdbc.queryForObject("SELECT password_hash FROM admin_account WHERE username=?",String.class,username); }
    catch(EmptyResultDataAccessException e) { throw new UsernameNotFoundException("administrator not found"); }
  }

  public boolean passwordHashMatches(String username,String expectedHash) {
    try { return expectedHash.equals(currentPasswordHash(username)); }
    catch(UsernameNotFoundException e) { return false; }
  }

  public void changePassword(String username,String currentPassword,String newPassword) {
    if(currentPassword==null || newPassword==null || newPassword.length()<12)
      throw ApiException.bad("new password must contain at least 12 characters");
    if(newPassword.getBytes(StandardCharsets.UTF_8).length>72)
      throw ApiException.bad("new password must be at most 72 UTF-8 bytes");
    String existing;
    try { existing=jdbc.queryForObject("SELECT password_hash FROM admin_account WHERE username=?",String.class,username); }
    catch(EmptyResultDataAccessException e) { throw new ApiException(40101,HttpStatus.UNAUTHORIZED,"administrator not found"); }
    if(!encoder.matches(currentPassword,existing))
      throw new ApiException(40002,HttpStatus.BAD_REQUEST,"current password is incorrect");
    if(encoder.matches(newPassword,existing)) throw ApiException.bad("new password must differ from current password");
    int changed=jdbc.update("UPDATE admin_account SET password_hash=?,updated_at=now() WHERE username=? AND password_hash=?",
      encoder.encode(newPassword),username,existing);
    if(changed!=1) throw ApiException.conflict("password was changed concurrently; retry");
  }
}
