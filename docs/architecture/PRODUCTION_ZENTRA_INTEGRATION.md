# Production Zentra integration design

This is design only; M0 does not connect to production Zentra.

Production business transactions should insert a semantic integration-outbox record in the same database transaction. A production-side dispatcher later signs and sends that record to the HQ ingestion boundary. Examples include `product.user_registered`, `product.company_created`, `product.ksef_connected`, `product.invoice_created`, `product.feature_used`, and `product.error_occurred`.

HQ should receive business facts such as `product.ksef_connected`, not storage facts such as `companies.ksef_token_updated`. HQ does not receive a production service-role key or broad database access. Delivery is duplicate-safe and provider/source IDs are preserved.
