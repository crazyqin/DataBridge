package com.databridge;

import java.util.List;

public final class UserAgentPolicy {
  private UserAgentPolicy() {}

  public static boolean allows(List<String> rules, String userAgent) {
    if (rules.isEmpty()) return true;
    if (userAgent == null || userAgent.isBlank()) return false;
    for (String rule : rules) {
      if (rule.endsWith("*")) {
        if (userAgent.startsWith(rule.substring(0,rule.length()-1))) return true;
      } else if (userAgent.equals(rule)) return true;
    }
    return false;
  }
}
