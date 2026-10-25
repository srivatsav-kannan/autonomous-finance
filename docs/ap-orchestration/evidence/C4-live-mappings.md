# Real QuickBooks sandbox reference mappings

At2026-10-25T10:08:15Z, the selected Sandbox Company US683a received eight owner-authorized reference records: one clearly synthetic AP97 supplier, six dedicated AP97 accounts and one AP97 store Class. Existing Accounts Payable33 was verified and retained. Exact names, active flags, account types, USD currency and IDs were read back before saving the server-only mapping. A subsequent full replay at10:08:30Z reused all IDs and madezeroPOSTs. [Evidence and IDs](C4-live-mappings.json).

Mapping version `ap97-us-sandbox-v1`, SHA256 `bcf31360c77300818651dea6c9a4fdb42a2a3dc57b93385c3ee67c4f3df972ff`. Setup uses an exact reviewed plan hash, fixed request IDs, persisted sending/unknown/verified state and strict exact-name query/readback. An uncertain previous creation cannot receive a fresh key or blind repost. All scripts, grants and operational journals remain in private ignored directories.

Account creation shape follows [Intuit's official tutorial](https://github.com/IntuitDeveloper/QBOConceptsTutorial-PHP/blob/master/LandingTheJob.php). Account subtypes were checked against current returned sandbox accounts and [Intuit's SDK enum](https://static.developer.intuit.com/sdkdocs/qbv3doc/ippdotnetdevkitv3/html/50796272-b70e-0c9b-77d9-00c18758396c.htm). Store Class is a separate explicit mapping; missing or changed dimensions block transaction synchronization.

No opening balance, Bill, VendorCredit, JournalEntry or BillPayment was created. No bank account was connected or funded, and no Increase transfer was initiated. Auth0-backed current business authority and actual transaction write/readback remain pending. Practitioner review of the policy/mapping semantics remains an external acceptance item.
