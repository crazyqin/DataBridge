package com.databridge;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.access.intercept.AuthorizationFilter;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.filter.OncePerRequestFilter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;

@Configuration
public class SecurityConfig {
  private static final String ADMIN_PASSWORD_HASH="ADMIN_PASSWORD_HASH";
  private final byte[] apiKeyHash;
  public SecurityConfig(@Value("${app.api-key}") String apiKey) {
    if (apiKey.isBlank()) throw new IllegalStateException("APP_API_KEY is required");
    this.apiKeyHash = digest(apiKey);
  }
  public boolean validApiKey(String candidate) {
    return candidate != null && MessageDigest.isEqual(apiKeyHash, digest(candidate));
  }
  private static byte[] digest(String value) {
    try { return MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)); }
    catch (Exception e) { throw new IllegalStateException(e); }
  }
  @Bean BCryptPasswordEncoder passwordEncoder() { return new BCryptPasswordEncoder(); }
  @Bean SecurityFilterChain filterChain(HttpSecurity http,AdminAccountService accounts) throws Exception {
    return http.csrf(csrf -> csrf.ignoringRequestMatchers("/open/**"))
      .authorizeHttpRequests(auth -> auth.requestMatchers("/admin/**").authenticated().anyRequest().permitAll())
      .formLogin(form -> form.loginProcessingUrl("/auth/login")
        .successHandler((request,response,authentication) -> {
          if(!(authentication.getPrincipal() instanceof AdminAccountService.AdminUser user)
              || !accounts.passwordHashMatches(user.username(),user.passwordHash())) {
            if(request.getSession(false)!=null) request.getSession(false).invalidate();
            SecurityContextHolder.clearContext();
            response.sendError(401,"password changed during login");
            return;
          }
          request.getSession().setAttribute(ADMIN_PASSWORD_HASH,user.passwordHash());
          response.setStatus(204);
        })
        .failureHandler((request,response,exception) -> response.sendError(401)).permitAll())
      .logout(logout -> logout.logoutUrl("/auth/logout")
        .logoutSuccessHandler((request,response,authentication) -> response.setStatus(204)))
      .httpBasic(basic -> {})
      .addFilterBefore(new OncePerRequestFilter() {
        @Override protected void doFilterInternal(HttpServletRequest request,HttpServletResponse response,FilterChain chain) throws ServletException,IOException {
          Authentication auth=SecurityContextHolder.getContext().getAuthentication();
          Object sessionHash=request.getSession(false)==null?null:request.getSession(false).getAttribute(ADMIN_PASSWORD_HASH);
          String path=request.getServletPath();
          if(path==null || path.isEmpty()) path=request.getRequestURI().substring(request.getContextPath().length());
          if(path.startsWith("/admin/") && auth!=null && sessionHash instanceof String hash
              && !accounts.passwordHashMatches(auth.getName(),hash)) {
            if(request.getSession(false)!=null) request.getSession(false).invalidate();
            SecurityContextHolder.clearContext();
            response.sendError(401,"session expired after password change");
            return;
          }
          chain.doFilter(request,response);
        }
      },AuthorizationFilter.class)
      .exceptionHandling(errors -> errors.authenticationEntryPoint((request,response,exception) -> response.sendError(401)))
      .build();
  }
}
