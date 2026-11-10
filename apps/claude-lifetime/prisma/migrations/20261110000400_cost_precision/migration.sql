-- Cost reports state amounts in cents with six decimals, which is eight decimals of a
-- dollar. With six decimals of a dollar every row was rounded when it was stored, so
-- small rows became 0 and the stored total differed from the report's own.
ALTER TABLE "reported_costs" ALTER COLUMN "amount_usd" TYPE DECIMAL(20,8);
