package com.databridge;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import java.io.BufferedReader;
import java.io.InputStreamReader;

@SpringBootApplication
public class DataBridgeApplication {
  public static void main(String[] args) throws Exception {
    if (args.length == 1 && "--hash-password".equals(args[0])) {
      String password = new BufferedReader(new InputStreamReader(System.in)).readLine();
      if (password == null || password.length() < 12) throw new IllegalArgumentException("password must contain at least 12 characters");
      System.out.println(new BCryptPasswordEncoder().encode(password));
      return;
    }
    SpringApplication.run(DataBridgeApplication.class, args);
  }
  @Bean public ThreadPoolTaskScheduler taskScheduler() {
    var scheduler = new ThreadPoolTaskScheduler();
    scheduler.setPoolSize(2);
    scheduler.setThreadNamePrefix("snapshot-");
    return scheduler;
  }
}
