package com.databridge;

import static org.junit.jupiter.api.Assertions.*;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.*;
import org.junit.jupiter.api.Test;

class CoreUnitTest {
  private final Json json=new Json(new ObjectMapper());
  @Test void rowKeyUsesFieldValuesAndFieldOrder() {
    var a=Map.<String,Object>of("id","A","name","first");
    var b=Map.<String,Object>of("id","A","name","renamed");
    assertEquals(RowKeys.key(a,List.of("id"),json),RowKeys.key(b,List.of("id"),json));
    assertNotEquals(RowKeys.key(a,List.of("id","name"),json),RowKeys.key(a,List.of("name","id"),json));
    assertThrows(ApiException.class,()->RowKeys.key(a,List.of("missing"),json));
  }
  @Test void sqlValidatorRejectsWritesAndMultipleStatements() {
    var sql=new SqlService(null,json);
    assertDoesNotThrow(()->sql.validate("WITH items AS (SELECT id FROM x) SELECT * FROM items"));
    assertDoesNotThrow(()->sql.validate("SELECT 'delete' AS word"));
    for(String statement:List.of("DELETE FROM x","SELECT * FROM x; DROP TABLE x","WITH a AS (DELETE FROM x RETURNING *) SELECT * FROM a","SELECT * INTO x FROM y","SELECT * FROM x FOR UPDATE","SELECT $$'$$; SELECT 2; SELECT $$'$$","SELECT 1; SELECT 2"))
      assertThrows(ApiException.class,()->sql.validate(statement));
  }
  @Test void cryptoUsesRandomNonce() {
    byte[] raw=new byte[32];new Random(1).nextBytes(raw);
    var crypto=new CryptoService(Base64.getEncoder().encodeToString(raw));
    String first=crypto.encrypt("secret"),second=crypto.encrypt("secret");
    assertNotEquals(first,second);assertEquals("secret",crypto.decrypt(first));
  }
  @Test void userAgentRulesRequireAnExactOrPrefixMatch() {
    assertTrue(UserAgentPolicy.allows(List.of(),null));
    assertTrue(UserAgentPolicy.allows(List.of("Client/1.0","Partner/*"),"Client/1.0"));
    assertTrue(UserAgentPolicy.allows(List.of("Client/1.0","Partner/*"),"Partner/2.0"));
    assertFalse(UserAgentPolicy.allows(List.of("Client/1.0"),"Client/1.0.1"));
    assertFalse(UserAgentPolicy.allows(List.of("Partner/*"),null));
  }
}
