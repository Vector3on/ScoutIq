# Source Audit: Magento Open Source (2.4-develop)

- Program: Adobe (Intigriti public bug bounty)
- In-scope asset (source-available line): Magento Open Source, `github.com/magento/magento2`
  (Adobe Commerce is the closed superset; the Open Source CE is the source-evident target.)
- Package identity confirmed: root `composer.json` `"name": "magento/magento2ce"` (Community Edition = Open Source).
- Branch / commit audited: `2.4-develop` @ `7a5b09b90b8efb7e989c2d5a578f156e8d41bb70` (2026-09-10).
- Latest release tag at audit time: `2.4.8` (stable); `2.4.9-beta1` in flight.
- Audit type: white-box SOURCE REVIEW only. No live testing of any Adobe/Magento production, staging, or third-party
  instance. All conclusions are code-derived and, where noted, need confirmation on a locally-owned install.
- Auditor: automated clean-lane pass. Hand-off to human (helios) for reachability/severity/filing decisions.

---

## 1. Method and scope of this pass

Followed the "diff, don't read the whole tree" method. The mature core is picked clean, so this pass targeted
FRESH code and one trust boundary at a time:

- Churn map: 950 commits / 90d (396 / 30d). 117 non-test PHP files changed in 120d, concentrated in
  Sales, Catalog, Backend, SalesRule, Config, SalesGraphQl, Quote, Checkout, CatalogImportExport.
- Boundaries reviewed:
  - GraphQL resolvers: enumerated EVERY mutation and every customer-owned entity resolver; checked object-level
    authorization (IDOR / BOLA / CWE-639 identity-from-request).
  - REST `webapi.xml`: every `ref="anonymous"` route reviewed for a sensitive operation exposed without auth.
  - Insecure deserialization (Magento's historically high-impact class): every non-test `unserialize(` sink.
  - SSRF URL fetchers, SQLi, XXE, file-upload/path-traversal validators, template/config XML loaders.
- Verification limit (clean-lane): PHP 8.4 + Composer are available, but there is NO MySQL/OpenSearch in this
  environment, so a DB-backed runtime Magento install was not possible. Runtime repro of the candidate below is
  therefore SEEDED to the human (seed-and-stop). The finding is source-evident: full control-flow and the complete
  DI chain (preferences + plugins) were traced by hand.

---

## 2. Finding SEED-001 (LOW / informational) — Missing object-level authorization on `estimateShippingMethods`

Best characterized as an authorization-parity gap / defense-in-depth hole, likely BELOW the payable floor on its
own. Seeded for helios to decide reachability. Do not overstate.

- Class: CWE-284 Improper Access Control / CWE-639 Authorization Bypass Through User-Controlled Key (BOLA).
- Repo path: `app/code/Magento/QuoteGraphQl/Model/Resolver/EstimateShippingMethods.php`
- Line range: `resolve()` at lines 58-76; the unguarded load is line 62.
- Commit-pinned permalink:
  https://github.com/magento/magento2/blob/7a5b09b90b8efb7e989c2d5a578f156e8d41bb70/app/code/Magento/QuoteGraphQl/Model/Resolver/EstimateShippingMethods.php#L58-L76

### What the code does

```php
// EstimateShippingMethods::resolve()  (lines 58-76)
$this->validateInput($args);                                  // checks cart_id + country_code are present only
$cart = $this->cartRepository->get(
    $this->maskedQuoteIdToQuoteId->execute($args['input']['cart_id'])   // masked id -> quote, NO owner check
);
return $this->getAvailableShippingMethodsForAddress($args['input']['address'], $cart);
```

The resolver resolves the caller-supplied masked `cart_id` to a quote and operates on it WITHOUT calling
`GetCartForUser::execute($maskedId, $userId, $storeId)` — the service every other cart resolver uses to enforce that
the quote belongs to the current session (customer id match, guest-vs-customer distinction, active flag, store).

### Read-path parity gap (why this is a gap, not an accident of style)

The sibling estimation resolver DOES enforce it:

- `app/code/Magento/QuoteGraphQl/Model/Resolver/EstimateTotals.php:96`
  `$this->getCartForUser->execute($maskedCartId, $currentUserId, $storeId);`
  permalink:
  https://github.com/magento/magento2/blob/7a5b09b90b8efb7e989c2d5a578f156e8d41bb70/app/code/Magento/QuoteGraphQl/Model/Resolver/EstimateTotals.php#L94-L96

Both take the same `EstimateTotalsInput` (`cart_id` + `address`). `estimateTotals` was hardened with
`GetCartForUser`; `estimateShippingMethods` was not. No DI plugin/preference restores the check:
`Quote/etc/di.xml:10` only maps `ShipmentEstimationInterface` -> `ShippingMethodManagement` (no interceptors), and
there are no before/around plugins on the resolver.

### Q1 — exact copy-paste attacker request (MANDATORY gate: PASSES)

```http
POST /graphql HTTP/1.1
Host: <your-owned-magento-host>
Content-Type: application/json

{"query":"mutation { estimateShippingMethods(input: { cart_id: \"<VICTIM_MASKED_CART_ID>\", address: { country_code: \"US\", region: { region_code: \"CA\" }, postcode: \"90001\" } }) { carrier_code method_code method_title amount { value currency } } }"}
```

No `Authorization` header is required (guest-callable; the resolver never checks `getIsCustomer()`).

### Preconditions (the load-bearing limitation — state plainly)

- The attacker must possess a valid masked `cart_id` that is not their own. Masked quote ids are 32-char
  CSPRNG values (`Magento\Framework\Math\Random::getRandomString` -> `random_int`), verified not brute-forceable.
  They are treated as a bearer capability and are not normally exposed to other users. This is why the practical
  severity is LOW and the attack complexity is HIGH.
- The target quote must be active and non-empty (`ShippingMethodManagement::estimateByExtendedAddress` calls
  `quoteRepository->getActive()` and returns `[]` for empty/virtual carts).

### Impact (honest, bounded)

- Read-only. `getShippingMethods()` (`app/code/Magento/Quote/Model/ShippingMethodManagement.php:329-353`) mutates
  the shipping address / totals IN MEMORY only; the resolver never calls `quoteRepository->save()`, so nothing is
  persisted to the victim cart. No integrity impact.
- Response contains shipping carrier/method codes, titles and amounts for the target cart against an
  attacker-chosen destination. No direct PII (no address, email, or line items) is returned.
- Weak inference side-channel only: free-shipping eligibility leaks a subtotal band; weight-based rates leak an
  approximate cart weight. Also an existence oracle for a given masked id (found vs "Could not find a cart").
- Customer-group pricing is NOT leaked: the code temporarily swaps in the CALLER's session customer group for the
  rate calc then restores (lines 337-351), so rates reflect the attacker's group, not the victim's.

### Severity (honest)

- Low / informational. Suggested CVSS 3.1: `AV:N/AC:H/PR:N/UI:N/S:U/C:L/I:N/A:N` ~= 3.1 (Low).
- Likely below the program's payable floor UNLESS helios can demonstrate a masked-cart-id LEAK (cache key,
  server log, Referer, shared link, prior response) that removes the AC:H precondition. That elevation is the
  reachability question to answer next, and it needs a live owned install — hence seed-and-stop.

### Local repro result

- NOT executed. Clean-lane environment has no MySQL/OpenSearch, so a runtime Magento install (needed to mint two
  carts and diff owner vs non-owner behavior) was not possible. Finding is source-evident; DI chain and control
  flow traced statically. Runtime confirmation handed to helios.

### Suggested fix (for the human's report, not applied here)

Mirror `EstimateTotals`: resolve `$currentUserId`/`$storeId` from `$context` and call
`GetCartForUser::execute($args['input']['cart_id'], $currentUserId, $storeId)` before estimating, so a customer
cart can only be estimated by its owner and a guest cart only via its (secret) masked id.

---

## 3. Secondary low observations (informational; not independently payable)

1. Wishlist transfer token not invalidated after use — `app/code/Magento/Wishlist/Model/DataSerializer.php:116`
   calls `$this->cache->remove($token)` with the un-prefixed key while the entry was saved under
   `wishlist_$token` (line 86/109), so the intended one-time token stays valid until its 7-day TTL. Functional /
   weak-hardening bug; data is the user's own wishlist payload. CWE-613-ish. Not a strong finding.

2. Non-constant-time confirmation-key comparison (guest order cancel) —
   `app/code/Magento/OrderCancellationGraphQl/Model/ConfirmCancelOrder.php:76` uses `!==` instead of
   `hash_equals()`. CWE-208. Not practically exploitable: the key is a 32-char CSPRNG value delivered only to the
   order's email, and the network timing channel cannot resolve a per-byte diff on a high-entropy secret. Hardening
   note only.

3. CMS page-by-id is not store-scoped — `app/code/Magento/CmsGraphQl/Model/Resolver/DataProvider/Page.php:63-67`
   (`getDataByPageId`) loads via `pageRepository->getById()` and only blocks inactive pages; the
   `getDataByPageIdentifier` path IS store-scoped. An active CMS page assigned to store B is readable from store A
   by numeric id. Low information exposure (published content); noted for completeness.

---

## 4. Verified clean (scoped to fresh code + the boundaries reviewed this pass)

These were checked and found robust — recorded so a future pass does not re-walk them blindly:

- Customer-owned GraphQL authorization (all enumerated):
  - Cart mutations (add/update/remove item, coupons, addresses, email, payment, place order) uniformly use
    `GetCartForUser::execute(maskedId, userId, storeId)`.
  - Wishlist mutations (add/remove/update/clear) enforce `$customerId === (int)$wishlist->getCustomerId()`.
  - Customer address update/delete route through `GetCustomerAddressV2` which enforces
    `(int)$address->getCustomerId() !== $customerId` -> throws.
  - Vault `deletePaymentToken` scopes lookup with `getByPublicHash($hash, $context->getUserId())` (own token only).
  - Sales: `customer { orders }` scoped to `getUserId()`; guest order lookup requires order number + billing email
    + billing lastname, rejects customer-owned orders, and the order "token" is AES-encrypted with the install
    crypt key (`SalesGraphQl/Model/Order/Token.php`) so it is not forgeable.
  - Order cancellation: customer path checks `(int)$order->getCustomerId() !== $context->getUserId()`; guest path
    uses a per-order 32-char CSPRNG confirmation key emailed to the order address.
- Insecure deserialization: no native `unserialize()` on user input. The `DataSerializer` /
  `RedirectDataCacheSerializer` classes use the random-token -> server-side-cache -> JSON `unserialize` pattern
  (attacker cannot inject the serialized payload).
- Anonymous REST (`webapi.xml`): only the standard guest storefront set (guest-carts / guest-checkout /
  registration / password reset / token issuance), all keyed by the masked-id capability model. No sensitive
  operation exposed anonymously by mistake.
- SSRF: URL fetchers (Directory currency import, UPS/USPS/DHL carriers, NewRelic, Integration OAuth endpoint) all
  take ADMIN-configured URLs, not unauthenticated input.
- SQLi / XXE: no raw string-concatenation into `where()/query()`; every `DOMDocument`/`loadXML` sink parses
  Magento's own on-disk config XML, not request data.
- File-upload validators (`MediaStorage/.../NotProtectedExtension`, `Theme/.../Favicon|Logo`) — recent changes are
  null-safe-config and visibility refactors, no weakening of the protected-extension blocklist.

Note on "secrets in git history": magento2 is a fully public repository; there is no private secret to disclose by
definition, so that check is N/A for this asset (test fixtures carry dummy keys only).

---

## 5. Hand-off (seed-and-stop)

Deliver to helios:

- SEED-001 is the only candidate that reaches the Q1 gate. It is a genuine missing-authorization parity gap but is
  gated by a secret masked cart id and returns non-sensitive rate data, so it reads as LOW / likely-sub-floor.
  The decision that needs a human + a live OWNED install: (a) does any surface leak another user's masked cart id,
  which would elevate this to a real BOLA; (b) confirm runtime behavior on owned Magento. File nothing until that
  is settled.
- Everything else in this pass is a verified-clean or hardening note. This is an honest, largely-hardened result;
  no finding was manufactured to fill the report.
