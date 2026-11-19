import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { leadingKeyword, splitSnowflakeSql } from '../../src/snowflake/split';

const split = (sql: string) => splitSnowflakeSql(sql).map((p) => p.sql);

describe('split: statement boundaries', () => {
  it('single statement with or without a semicolon', () => {
    assert.deepEqual(split('select 1'), ['select 1']);
    assert.deepEqual(split('select 1;'), ['select 1']);
    assert.deepEqual(split('  select 1 ;  \n'), ['select 1']);
  });

  it('several statements; empty ones and comment-only tails dropped', () => {
    assert.deepEqual(split('select 1; ; select 2;\n-- done\n'), ['select 1', 'select 2']);
  });

  it('semicolons inside strings, identifiers and comments do not split', () => {
    assert.deepEqual(split(`select 'a;b' as "x;y"; select 'it''s; fine', 'back\\';slash'`), [
      `select 'a;b' as "x;y"`,
      `select 'it''s; fine', 'back\\';slash'`,
    ]);
    assert.deepEqual(split('select 1 -- c;omment\n; select 2 // also; comment\n; select /* ; */ 3'), [
      'select 1 -- c;omment',
      'select 2 // also; comment',
      'select /* ; */ 3',
    ]);
  });

  it('dollar-quoted bodies stay whole', () => {
    const proc = `create or replace procedure p() returns int language javascript as $$ var a = 1; return a; $$`;
    assert.deepEqual(split(`${proc}; call p();`), [proc, 'call p()']);
    assert.deepEqual(split(`execute immediate $$ select 1; select 2; $$;`), [`execute immediate $$ select 1; select 2; $$`]);
  });

  it('anonymous Snowflake Scripting block (BEGIN ... END)', () => {
    const block = `begin\n  create table t (x int);\n  insert into t values (1);\n  return 'ok';\nend`;
    assert.deepEqual(split(`${block};\nselect 1;`), [block, 'select 1']);
  });

  it('DECLARE section + nested IF / FOR / LOOP / CASE', () => {
    const block = `declare
  total int default 0;
  c1 cursor for select 1;
begin
  for i in 1 to 3 do
    total := total + i;
  end for;
  if (total > 5) then
    total := total * 10;
  elseif (total = 0) then
    total := -1;
  end if;
  loop
    break;
  end loop;
  case (total)
    when 60 then total := 61;
    else total := 0;
  end case;
  let x := case when total > 0 then 'pos' else 'neg' end;
  begin
    total := total + 1;
  end;
  return total;
end`;
    assert.deepEqual(split(`${block};\nselect 2;`), [block, 'select 2']);
  });

  it('stored procedure body without $$ (Snowsight style)', () => {
    const proc = `create or replace procedure p()
returns varchar
language sql
as
declare
  v varchar default 'x';
begin
  return v;
end`;
    assert.deepEqual(split(`${proc};\ncall p();`), [proc, 'call p()']);
  });

  it('BEGIN / BEGIN TRANSACTION / BEGIN WORK are transaction statements', () => {
    assert.deepEqual(split('begin; insert into t values (1); commit;'), ['begin', 'insert into t values (1)', 'commit']);
    assert.deepEqual(split('begin transaction; rollback;'), ['begin transaction', 'rollback']);
    assert.deepEqual(split('BEGIN WORK; COMMIT WORK;'), ['BEGIN WORK', 'COMMIT WORK']);
    assert.deepEqual(split('begin transaction name t1; commit;'), ['begin transaction name t1', 'commit']);
  });

  it('CASE ... END expressions at top level do not swallow statements', () => {
    assert.deepEqual(split(`select case when 1=1 then 'a' else 'b' end as c; select 2;`), [
      `select case when 1=1 then 'a' else 'b' end as c`,
      'select 2',
    ]);
  });

  it('identifiers that merely contain keywords do not count', () => {
    assert.deepEqual(split('select begin_date, end_date, legend from t; select 1;'), [
      'select begin_date, end_date, legend from t',
      'select 1',
    ]);
  });

  it('unterminated string / comment keep the rest as one statement', () => {
    assert.deepEqual(split(`select 'oops; select 2`), [`select 'oops; select 2`]);
    assert.deepEqual(split('select 1; /* never closed ; select 2'), ['select 1']);
  });

  it('only comments → nothing to run', () => {
    assert.deepEqual(split('-- nothing\n/* here */'), []);
  });
});

describe('split: leadingKeyword', () => {
  it('skips comments and parentheses, upper-cases', () => {
    assert.equal(leadingKeyword('-- c\n/* x */ insert into t values (1)'), 'INSERT');
    assert.equal(leadingKeyword('(select 1)'), 'SELECT');
    assert.equal(leadingKeyword('  with x as (select 1) select * from x'), 'WITH');
    assert.equal(leadingKeyword(''), '');
  });
});
