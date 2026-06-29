# Safe Positioning — Enterprise Messaging Guide

## المبدأ: لا تبع الأرقام، بع الآلية

الأرقام الحالية (33 events, 93.9%, 86.3%) هي من **pilot أولي على 22 repo**. هي تدعم الفرضية لكنها لا تثبت استقرارًا إحصائيًا.

في outreach للشركات الكبرى: بع **لماذا يعمل** وليس **كم كانت النتيجة في الأسبوع الأول**.

---

## النسخة الآمنة — لكل قناة

### Cold Email

**Before (overfit):**
> Running on 22 repos: 93.9% merge rate, 86.3% accuracy, $0.03/PR.

**After (safe):**
> We built a closed-loop system between CI and LLM — every PR outcome (merge/close) feeds back into the model's knowledge base. Proven patterns become reusable policies. The system learns which fixes work and which don't, reducing repeated LLM cost over time.

---

### LinkedIn

**Before:**
> 33 truth events, 3 policies at 100% confidence.

**After:**
> Most AI coding tools generate once and forget. We built a layer that captures outcomes, learns from merge/close events, and lets you reuse proven fixes. First PR costs LLM inference. The next similar fix costs near zero. Because the system learns.

---

### Twitter / X

**Before:**
> 93.9% merge rate. 3 auto-policies. Cost drops per cycle.

**After:**
> Every LLM call in your pipeline vanishes. We built one where the output feeds back into reusable knowledge. Same bug next sprint? The system already knows how to fix it.

---

### CTO Call Opening

**Before:**
> 93.9% merge rate across 22 repos.

**After:**
> We built a truth feedback loop for LLM-generated code. Every PR outcome updates the system's confidence. Over time, common fixes get handled from memory. Your cost per PR drops. Your audit trail stays complete.

---

## الخط الأحمر: لا تقل هذه العبارات بدون تحفظ

| العبارة | المشكلة |
|---------|---------|
| "93.9% merge rate" | إحصائيًا غير مستقرة (n=33). |
| "86.3% accuracy" | محسوبة من pilot محدود. |
| "100% confidence" | الـ policies عندها 100% confidence لكن هذا يعكس بيانات التدريب وليس استقرارًا في الإنتاج. |
| "works at scale" | لم يُختبر بعد عند scale حقيقي. |
| "replaces human review" | لا يستبدل، يقلل الضوضاء. |

## البدائل الآمنة

| استخدم | بدل |
|--------|-----|
| "early signal" | "proven results" |
| "running on production repos" | "production-ready" |
| "cost decreases with reuse" | "93% cheaper" |
| "system learns from outcomes" | "system achieves X% accuracy" |
| "pilot on 22 repos" | "tested across multiple codebases" |

## القاعدة الذهبية

> في الـ outreach، صف الآلية. الأرقام احتفظ بها للـ demo والدليل التقني.

الآلية هي القصة: LLM → Candidate → Truth → Policy → Reuse.
الأرقام دليل مؤقت. الآلية هي المنتج.
