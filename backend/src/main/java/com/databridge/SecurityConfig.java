package com.databridge;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.web.SecurityFilterChain;

@Configuration
public class SecurityConfig {
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
  @Bean SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
    return http.csrf(csrf -> csrf.disable())
      .authorizeHttpRequests(auth -> auth.requestMatchers("/admin/**").authenticated().anyRequest().permitAll())
      .formLogin(form -> form.loginProcessingUrl("/auth/login")
        .successHandler((request,response,authentication) -> response.setStatus(204))
        .failureHandler((request,response,exception) -> response.sendError(401)).permitAll())
      .logout(logout -> logout.logoutUrl("/auth/logout")
        .logoutSuccessHandler((request,response,authentication) -> response.setStatus(204)))
      .httpBasic(basic -> {})
      .exceptionHandling(errors -> errors.authenticationEntryPoint((request,response,exception) -> response.sendError(401)))
      .build();
  }
}
