-- 通行記録台帳とお金の台帳を「追記専用」にする。
-- UPDATE / DELETE / TRUNCATE はデータベース自身が拒否する（アプリのバグや不正な操作があっても書き換えられない）。

CREATE OR REPLACE FUNCTION pashiri_reject_modification() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% は追記専用です（% は禁止）', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_ledger_append_only
  BEFORE UPDATE OR DELETE ON "AuditLedger"
  FOR EACH ROW EXECUTE FUNCTION pashiri_reject_modification();
CREATE TRIGGER audit_ledger_no_truncate
  BEFORE TRUNCATE ON "AuditLedger"
  FOR EACH STATEMENT EXECUTE FUNCTION pashiri_reject_modification();

CREATE TRIGGER money_journal_append_only
  BEFORE UPDATE OR DELETE ON "MoneyJournal"
  FOR EACH ROW EXECUTE FUNCTION pashiri_reject_modification();
CREATE TRIGGER money_journal_no_truncate
  BEFORE TRUNCATE ON "MoneyJournal"
  FOR EACH STATEMENT EXECUTE FUNCTION pashiri_reject_modification();

CREATE TRIGGER money_line_append_only
  BEFORE UPDATE OR DELETE ON "MoneyLine"
  FOR EACH ROW EXECUTE FUNCTION pashiri_reject_modification();
CREATE TRIGGER money_line_no_truncate
  BEFORE TRUNCATE ON "MoneyLine"
  FOR EACH STATEMENT EXECUTE FUNCTION pashiri_reject_modification();

-- 仕訳ごとに借方合計＝貸方合計であることを、取引の確定時にチェックする
CREATE OR REPLACE FUNCTION pashiri_check_journal_balance() RETURNS trigger AS $$
DECLARE
  d INTEGER;
  c INTEGER;
BEGIN
  SELECT COALESCE(SUM("debitJpy"), 0), COALESCE(SUM("creditJpy"), 0) INTO d, c
    FROM "MoneyLine" WHERE "journalId" = NEW."journalId";
  IF d <> c THEN
    RAISE EXCEPTION '仕訳 % の借方(%)と貸方(%)が一致しません', NEW."journalId", d, c;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER money_line_balanced
  AFTER INSERT ON "MoneyLine"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION pashiri_check_journal_balance();
