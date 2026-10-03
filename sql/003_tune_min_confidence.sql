-- 003: lower the default min_confidence from 0.7 to 0.6.
-- Scored against realistic headlines, 0.7 let through only ~3 of 12 stories (good ones such as
-- earnings and treasury purchases scored 0.63), while 0.6 still rejects opinion pieces, fluff and
-- off-topic items. Only touches the value if it is still the old seeded default: a value you set
-- yourself is never overwritten.
update settings set value = '0.6', updated_at = now()
 where key = 'min_confidence' and value = '0.7'::jsonb;
