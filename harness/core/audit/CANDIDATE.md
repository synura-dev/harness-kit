# Candidate (hop dong chung)

Moi nguon "ung vien cai tien" (loi lap, quy trinh lap, ...) tra mang object cung dang, engine luat doc truc tiep:

| field | nghia |
|---|---|
| id | on dinh theo fp (chuoi) |
| kind | `error` (loi lap), `pattern` (quy trinh lap), mo rong tuy y |
| fp | dau van tay chuan hoa; cung fp = cung van de |
| count / sessions | so lan / so phien khac nhau |
| first_ts / last_ts | ISO hoac null |
| sample | mau da che bi mat, <= 200 ky tu |
| cost_ms? | tong thoi gian ton (neu biet) |
| tool?, occ? | tuy chon: ten tool; [{sid, ts}] gan nhat (ledger dung de suy acted/ignored) |

`candidate-shape.mjs`: `validateCandidate`, `failureCandidates(events, nowIso)` (boc `repeatedFailureCandidates`, kind=error).
Nguon quy trinh lap tra cung dang voi kind='pattern'.
