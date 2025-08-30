;; EnvLedger.clar
;; Core immutable ledger for storing and querying validated urban environmental data
;; Integrates with ValidationPool.clar for data ingestion and GovernanceDAO.clar for admin controls
;; Stores environmental observations (e.g., PM2.5, noise) with metadata, supports querying and NFT minting

;; Constants
(define-constant CONTRACT_OWNER tx-sender)
(define-constant ERR_NOT_AUTHORIZED (err u100))
(define-constant ERR_INVALID_DATA (err u101))
(define-constant ERR_DATA_EXISTS (err u102))
(define-constant ERR_INVALID_QUERY (err u103))
(define-constant ERR_NOT_FOUND (err u104))
(define-constant ERR_PAUSED (err u105))
(define-constant ERR_INVALID_TIMESTAMP (err u106))
(define-constant ERR_INVALID_LOCATION (err u107))
(define-constant ERR_INVALID_EVIDENCE (err u108))
(define-constant ERR_INVALID_PRINCIPAL (err u109))
(define-constant ERR_INVALID_TOKEN_ID (err u110))
(define-constant MAX_TAGS u10)
(define-constant MAX_METADATA_LEN u500)
(define-constant MAX_AGGREGATE_RESULTS u100)
(define-constant ZERO_PRINCIPAL 'SP000000000000000000002Q6VF78)

;; Data Variables
(define-data-var contract-paused bool false)
(define-data-var admin principal CONTRACT_OWNER)
(define-data-var validation-pool principal ZERO_PRINCIPAL)
(define-data-var data-counter uint u0)

;; Data Maps
(define-map environmental-data
  { data-id: uint }
  {
    data-type: (string-utf8 50),          ;; e.g., "PM2.5", "noise-decibels"
    value: int,                           ;; Measurement value (scaled)
    location-lat: int,                    ;; Latitude * 1e6
    location-lon: int,                    ;; Longitude * 1e6
    timestamp: uint,                      ;; Unix timestamp
    contributor: principal,
    evidence-hash: (buff 32),             ;; SHA-256 hash of evidence
    metadata: (string-utf8 500),          ;; Additional notes
    tags: (list 10 (string-utf8 20)),     ;; Categorization tags
    validated-at: uint,                   ;; Block height of validation
    quality-score: uint                   ;; 0-100 score
  }
)

(define-map data-by-type
  { data-type: (string-utf8 50), data-id: uint }
  { dummy: bool }
)

(define-map data-by-location
  { location-hash: (buff 32), data-id: uint }
  { dummy: bool }
)

(define-map data-by-timestamp
  { timestamp: uint, data-id: uint }
  { dummy: bool }
)

(define-map data-by-contributor
  { contributor: principal, data-id: uint }
  { dummy: bool }
)

(define-map aggregate-stats
  { data-type: (string-utf8 50), period: uint }
  {
    count: uint,
    sum: int,
    min: int,
    max: int,
    avg: int
  }
)

(define-map data-nfts
  { data-id: uint }
  {
    owner: principal,
    minted: bool,
    token-id: uint
  }
)

;; Private Functions
(define-private (is-authorized-caller (caller principal))
  (or (is-eq caller (var-get admin))
      (is-eq caller (var-get validation-pool)))
)

(define-private (compute-location-hash (lat int) (lon int))
  (hash160 (fold + (concat (unwrap-panic (to-consensus-buff? lat)) (unwrap-panic (to-consensus-buff? lon))) 0x))
)

(define-private (update-indexes (data-id uint) (data {
    data-type: (string-utf8 50),
    value: int,
    location-lat: int,
    location-lon: int,
    timestamp: uint,
    contributor: principal,
    evidence-hash: (buff 32),
    metadata: (string-utf8 500),
    tags: (list 10 (string-utf8 20)),
    validated-at: uint,
    quality-score: uint
  }))
  (begin
    (map-set data-by-type {data-type: (get data-type data), data-id: data-id} {dummy: true})
    (map-set data-by-location {location-hash: (compute-location-hash (get location-lat data) (get location-lon data)), data-id: data-id} {dummy: true})
    (map-set data-by-timestamp {timestamp: (get timestamp data), data-id: data-id} {dummy: true})
    (map-set data-by-contributor {contributor: (get contributor data), data-id: data-id} {dummy: true})
    (try! (update-aggregates data))
    (ok true)
  )
)

(define-private (update-aggregates (data {
    data-type: (string-utf8 50),
    value: int,
    location-lat: int,
    location-lon: int,
    timestamp: uint,
    contributor: principal,
    evidence-hash: (buff 32),
    metadata: (string-utf8 500),
    tags: (list 10 (string-utf8 20)),
    validated-at: uint,
    quality-score: uint
  }))
  (let (
    (data-type (get data-type data))
    (value (get value data))
    (period (/ (get timestamp data) u86400))
    (current-agg (default-to {count: u0, sum: 0, min: 2147483647, max: -2147483648, avg: 0} (map-get? aggregate-stats {data-type: data-type, period: period})))
    (new-count (+ (get count current-agg) u1))
    (new-sum (+ (get sum current-agg) value))
    (new-min (if (< value (get min current-agg)) value (get min current-agg)))
    (new-max (if (> value (get max current-agg)) value (get max current-agg)))
    (new-avg (/ new-sum (to-int new-count)))
  )
    (map-set aggregate-stats {data-type: data-type, period: period}
      {count: new-count, sum: new-sum, min: new-min, max: new-max, avg: new-avg})
    (ok true)
  )
)

;; Public Functions
(define-public (add-validated-data 
  (data-type (string-utf8 50))
  (value int)
  (location-lat int)
  (location-lon int)
  (timestamp uint)
  (contributor principal)
  (evidence-hash (buff 32))
  (metadata (string-utf8 500))
  (tags (list 10 (string-utf8 20)))
  (quality-score uint)
)
  (if (var-get contract-paused)
    ERR_PAUSED
    (if (is-authorized-caller tx-sender)
      (let (
        (data-id (+ (var-get data-counter) u1))
        (data {
          data-type: data-type,
          value: value,
          location-lat: location-lat,
          location-lon: location-lon,
          timestamp: timestamp,
          contributor: contributor,
          evidence-hash: evidence-hash,
          metadata: metadata,
          tags: tags,
          validated-at: block-height,
          quality-score: quality-score
        })
      )
        (asserts! (> (len data-type) u0) ERR_INVALID_DATA)
        (asserts! (and (>= location-lat -90000000) (<= location-lat 90000000)) ERR_INVALID_LOCATION)
        (asserts! (and (>= location-lon -180000000) (<= location-lon 180000000)) ERR_INVALID_LOCATION)
        (asserts! (> timestamp u0) ERR_INVALID_TIMESTAMP)
        (asserts! (not (is-eq evidence-hash 0x0000000000000000000000000000000000000000000000000000000000000000)) ERR_INVALID_EVIDENCE)
        (asserts! (<= (len tags) MAX_TAGS) ERR_INVALID_DATA)
        (asserts! (<= (len metadata) MAX_METADATA_LEN) ERR_INVALID_DATA)
        (asserts! (<= quality-score u100) ERR_INVALID_DATA)
        (asserts! (not (is-eq contributor ZERO_PRINCIPAL)) ERR_INVALID_PRINCIPAL)
        (map-set environmental-data {data-id: data-id} data)
        (try! (update-indexes data-id data))
        (var-set data-counter data-id)
        (print {event: "data-added", data-id: data-id, contributor: contributor, data-type: data-type})
        (ok data-id)
      )
      ERR_NOT_AUTHORIZED
    )
  )
)

(define-public (pause-contract)
  (if (is-eq tx-sender (var-get admin))
    (begin
      (var-set contract-paused true)
      (ok true)
    )
    ERR_NOT_AUTHORIZED
  )
)

(define-public (unpause-contract)
  (if (is-eq tx-sender (var-get admin))
    (begin
      (var-set contract-paused false)
      (ok true)
    )
    ERR_NOT_AUTHORIZED
  )
)

(define-public (set-admin (new-admin principal))
  (if (is-eq tx-sender (var-get admin))
    (begin
      (asserts! (not (is-eq new-admin ZERO_PRINCIPAL)) ERR_INVALID_PRINCIPAL)
      (var-set admin new-admin)
      (ok true)
    )
    ERR_NOT_AUTHORIZED
  )
)

(define-public (set-validation-pool (new-pool principal))
  (if (is-eq tx-sender (var-get admin))
    (begin
      (asserts! (not (is-eq new-pool ZERO_PRINCIPAL)) ERR_INVALID_PRINCIPAL)
      (var-set validation-pool new-pool)
      (ok true)
    )
    ERR_NOT_AUTHORIZED
  )
)

(define-public (mint-data-nft (data-id uint) (token-id uint))
  (let (
    (data (map-get? environmental-data {data-id: data-id}))
    (existing-nft (map-get? data-nfts {data-id: data-id}))
  )
    (asserts! (is-some data) ERR_NOT_FOUND)
    (asserts! (is-eq tx-sender (get contributor (unwrap-panic data))) ERR_NOT_AUTHORIZED)
    (asserts! (not (get minted (default-to {owner: tx-sender, minted: false, token-id: u0} existing-nft))) ERR_DATA_EXISTS)
    (asserts! (> token-id u0) ERR_INVALID_TOKEN_ID)
    (asserts! (is-some (map-get? environmental-data {data-id: data-id})) ERR_NOT_FOUND)
    (map-set data-nfts {data-id: data-id} {owner: tx-sender, minted: true, token-id: token-id})
    (print {event: "nft-minted", data-id: data-id, token-id: token-id})
    (ok true)
  )
)

;; Read-Only Functions
(define-read-only (get-data (data-id uint))
  (map-get? environmental-data {data-id: data-id})
)

(define-read-only (get-data-by-type (data-type (string-utf8 50)) (start-id uint) (limit uint))
  (let (
    (indices (list u0 u1 u2 u3 u4 u5 u6 u7 u8 u9 u10 u11 u12 u13 u14 u15 u16 u17 u18 u19
                   u20 u21 u22 u23 u24 u25 u26 u27 u28 u29 u30 u31 u32 u33 u34 u35 u36 u37 u38 u39
                   u40 u41 u42 u43 u44 u45 u46 u47 u48 u49 u50 u51 u52 u53 u54 u55 u56 u57 u58 u59
                   u60 u61 u62 u63 u64 u65 u66 u67 u68 u69 u70 u71 u72 u73 u74 u75 u76 u77 u78 u79
                   u80 u81 u82 u83 u84 u85 u86 u87 u88 u89 u90 u91 u92 u93 u94 u95 u96 u97 u98 u99))
    (filtered-indices (filter (lambda (id) (is-some (map-get? data-by-type {data-type: data-type, data-id: (+ start-id id)}))) indices))
    (bounded-indices (slice? filtered-indices u0 (min limit (len filtered-indices))))
  )
    (map (lambda (id) (map-get? environmental-data {data-id: (+ start-id id)})) bounded-indices)
  )
)

(define-read-only (get-data-by-location (lat int) (lon int) (start-id uint) (limit uint))
  (let (
    (loc-hash (compute-location-hash lat lon))
    (indices (list u0 u1 u2 u3 u4 u5 u6 u7 u8 u9 u10 u11 u12 u13 u14 u15 u16 u17 u18 u19
                   u20 u21 u22 u23 u24 u25 u26 u27 u28 u29 u30 u31 u32 u33 u34 u35 u36 u37 u38 u39
                   u40 u41 u42 u43 u44 u45 u46 u47 u48 u49 u50 u51 u52 u53 u54 u55 u56 u57 u58 u59
                   u60 u61 u62 u63 u64 u65 u66 u67 u68 u69 u70 u71 u72 u73 u74 u75 u76 u77 u78 u79
                   u80 u81 u82 u83 u84 u85 u86 u87 u88 u89 u90 u91 u92 u93 u94 u95 u96 u97 u98 u99))
    (filtered-indices (filter (lambda (id) (is-some (map-get? data-by-location {location-hash: loc-hash, data-id: (+ start-id id)}))) indices))
    (bounded-indices (slice? filtered-indices u0 (min limit (len filtered-indices))))
  )
    (map (lambda (id) (map-get? environmental-data {data-id: (+ start-id id)})) bounded-indices)
  )
)

(define-read-only (get-data-by-timestamp (timestamp uint) (limit uint))
  (let (
    (indices (list u0 u1 u2 u3 u4 u5 u6 u7 u8 u9 u10 u11 u12 u13 u14 u15 u16 u17 u18 u19
                   u20 u21 u22 u23 u24 u25 u26 u27 u28 u29 u30 u31 u32 u33 u34 u35 u36 u37 u38 u39
                   u40 u41 u42 u43 u44 u45 u46 u47 u48 u49 u50 u51 u52 u53 u54 u55 u56 u57 u58 u59
                   u60 u61 u62 u63 u64 u65 u66 u67 u68 u69 u70 u71 u72 u73 u74 u75 u76 u77 u78 u79
                   u80 u81 u82 u83 u84 u85 u86 u87 u88 u89 u90 u91 u92 u93 u94 u95 u96 u97 u98 u99))
    (filtered-indices (filter (lambda (id) (is-some (map-get? data-by-timestamp {timestamp: timestamp, data-id: id}))) indices))
    (bounded-indices (slice? filtered-indices u0 (min limit (len filtered-indices))))
  )
    (map (lambda (id) (map-get? environmental-data {data-id: id})) bounded-indices)
  )
)

(define-read-only (get-data-by-contributor (contributor principal) (start-id uint) (limit uint))
  (let (
    (indices (list u0 u1 u2 u3 u4 u5 u6 u7 u8 u9 u10 u11 u12 u13 u14 u15 u16 u17 u18 u19
                   u20 u21 u22 u23 u24 u25 u26 u27 u28 u29 u30 u31 u32 u33 u34 u35 u36 u37 u38 u39
                   u40 u41 u42 u43 u44 u45 u46 u47 u48 u49 u50 u51 u52 u53 u54 u55 u56 u57 u58 u59
                   u60 u61 u62 u63 u64 u65 u66 u67 u68 u69 u70 u71 u72 u73 u74 u75 u76 u77 u78 u79
                   u80 u81 u82 u83 u84 u85 u86 u87 u88 u89 u90 u91 u92 u93 u94 u95 u96 u97 u98 u99))
    (filtered-indices (filter (lambda (id) (is-some (map-get? data-by-contributor {contributor: contributor, data-id: (+ start-id id)}))) indices))
    (bounded-indices (slice? filtered-indices u0 (min limit (len filtered-indices))))
  )
    (map (lambda (id) (map-get? environmental-data {data-id: (+ start-id id)})) bounded-indices)
  )
)

(define-read-only (get-aggregate-stats (data-type (string-utf8 50)) (period uint))
  (map-get? aggregate-stats {data-type: data-type, period: period})
)

(define-read-only (get-nft-info (data-id uint))
  (map-get? data-nfts {data-id: data-id})
)

(define-read-only (is-paused)
  (var-get contract-paused)
)

(define-read-only (get-admin)
  (var-get admin)
)

(define-read-only (get-validation-pool)
  (var-get validation-pool)
)

(define-read-only (get-data-counter)
  (var-get data-counter)
)