// テスト用の環境変数。本物の .env は使わない（テスト専用 DB とモック決済）
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://pashiri:pashiri@localhost:5432/pashiri_test?schema=public";
process.env.APP_URL = "http://localhost:3000";
process.env.APP_SECRET = "test-secret-0123456789abcdef0123456789abcdef";
process.env.PAYMENT_MODE = "mock";
process.env.STRIPE_SECRET_KEY = "";
process.env.STRIPE_PUBLISHABLE_KEY = "";
process.env.STORAGE_DIR = "./storage-test";
