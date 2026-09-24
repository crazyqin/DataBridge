package com.databridge;

import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Base64;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

@Component
public class CryptoService {
  private final SecretKeySpec key;
  private final SecureRandom random = new SecureRandom();
  public CryptoService(@Value("${app.secret-key}") String encoded) {
    byte[] bytes;
    try { bytes = Base64.getDecoder().decode(encoded); } catch (Exception e) { throw new IllegalStateException("APP_SECRET_KEY must be Base64 encoded", e); }
    if (bytes.length != 32) throw new IllegalStateException("APP_SECRET_KEY must decode to 32 bytes");
    key = new SecretKeySpec(bytes, "AES");
  }
  public String encrypt(String plaintext) {
    try {
      byte[] iv = new byte[12]; random.nextBytes(iv);
      var cipher = Cipher.getInstance("AES/GCM/NoPadding");
      cipher.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(128, iv));
      byte[] encrypted = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
      byte[] result = new byte[iv.length + encrypted.length];
      System.arraycopy(iv, 0, result, 0, iv.length);
      System.arraycopy(encrypted, 0, result, iv.length, encrypted.length);
      return Base64.getEncoder().encodeToString(result);
    } catch (Exception e) { throw new IllegalStateException("encryption failed", e); }
  }
  public String decrypt(String encoded) {
    try {
      byte[] value = Base64.getDecoder().decode(encoded);
      byte[] iv = java.util.Arrays.copyOfRange(value, 0, 12);
      var cipher = Cipher.getInstance("AES/GCM/NoPadding");
      cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, iv));
      return new String(cipher.doFinal(value, 12, value.length - 12), StandardCharsets.UTF_8);
    } catch (Exception e) { throw new IllegalStateException("decryption failed", e); }
  }
}
