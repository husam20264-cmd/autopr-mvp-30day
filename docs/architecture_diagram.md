# Architecture: Knowledge Governance System

## طبقات النظام الأربع

```
 ┌──────────────────────────────────────────────────────────────┐
 │                   4. PLUGIN LAYER                            │
 │  VS Code │ GitHub Actions │ CI Gate │ Security Connector    │
 ├──────────────────────────────────────────────────────────────┤
 │                   3. POLICY LAYER                             │
 │  meta_policies │ auto_approve │ apply_cached_diff           │
 │  PolicyPromoter │ Calibrator │ Policy Deactivation          │
 ├──────────────────────────────────────────────────────────────┤
 │                   2. TRUTH LAYER                              │
 │  TruthEvents │ TruthReconciler │ Calibrator                 │
 │  Outcome: merged/closed │ Confidence Calibration            │
 │  Accuracy Metrics │ Truth Calibration History               │
 ├──────────────────────────────────────────────────────────────┤
 │                   1. KNOWLEDGE LAYER                          │
 │  PatternMemory │ KnowledgeGraph │ MemoryCache               │
 │  CausalEdges │ DecisionLogs │ ReasoningChain                │
 │  TrapPatterns │ MetaRules │ MetaBehaviors                   │
 └──────────────────────────────────────────────────────────────┘
```

## تدفق دورة الحياة الكاملة

```
                        ┌──────────────┐
                        │   Webhook    │
                        │  (Push/PR)   │
                        └──────┬───────┘
                               │ event
                               ▼
 ┌─────────────────────────────────────────────────────────────┐
 │                    DECISION ENGINE                           │
 │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐ │
 │  │Classifier│─▶│  Memory  │─▶│   LLM    │─▶│   Safety   │ │
 │  │  fixType │  │  Lookup  │  │ Generate │  │   5 Rules  │ │
 │  └──────────┘  └────┬─────┘  └──────────┘  └──────┬─────┘ │
 │                     │                             │        │
 │               MEMORY_HIT                     SAFE/FAIL    │
 │                     │                             │        │
 │                     ▼                             ▼        │
 │               ┌──────────┐                 ┌──────────┐    │
 │               │  Trust   │                 │ Verifier │    │
 │               │  Scorer  │────────────────▶│  tsc +   │    │
 │               └──────────┘                 │  lint    │    │
 │                                            └────┬─────┘    │
 │                                                 │          │
 │                                                 ▼          │
 │                                            ┌──────────┐    │
 │                                            │   PR     │    │
 │                                            │ Created  │    │
 │                                            └────┬─────┘    │
 └─────────────────────────────────────────────────┼──────────┘
                                                    │
                                                    ▼
                                              ┌──────────┐
                                              │  Human   │
                                              │ Outcome  │
                                              │M/erge-Cls│
                                              └────┬─────┘
                                                    │
                     ┌──────────────────────────────┘
                     ▼
 ┌─────────────────────────────────────────────────────────────┐
 │                     TRUTH RECONCILER                         │
 │                                                              │
 │  ┌────────────┐  ┌──────────────┐  ┌──────────┐  ┌───────┐ │
 │  │  Pattern   │  │  Knowledge   │  │Threshold │  │Accur- │ │
 │  │  Memory    │  │   Graph      │  │Calibrat. │  │acy    │ │
 │  │  ↑/↓ conf  │  │  + edge      │  │  auto    │  │Metric │ │
 │  └────────────┘  └──────────────┘  └──────────┘  └───────┘ │
 └─────────────────────────────────────────────────┬───────────┘
                                                    │
                                                    ▼
 ┌─────────────────────────────────────────────────────────────┐
 │                     POLICY PROMOTER                          │
 │  evaluatePatternsForPromotion()                              │
 │  promoteToPolicy() if: confidence≥0.8 AND used≥10           │
 │                       AND repos≥3 AND accept≥75%            │
 │  verifyPolicies(): deactivate if mergeRate < 60%            │
 └─────────────────────────────────────────────────────────────┘
```

## جداول البيانات (20 جدولاً، 3 مصادر حقيقة)

```
مصدر الحقيقة الأول:        decision_logs (التتبع السببي)
مصدر الحقيقة الثاني:        truth_events (نتائج الـ merge/close)
مصدر الحقيقة الثالث:        patterns (المعرفة المتراكمة)

يجب أن تُشتق كل metrics من هذه المصادر فقط، لا عدادات منفصلة.
```

## تسلسل التعلم (3 حلقات)

```
حلقة سريعة (ثوانٍ):
  Memory lookup → HIT → PR created (بدون LLM)

حلقة متوسطة (دقائق):
  Memory lookup → MISS → LLM → PR → merged → TruthReconciler

حلقة بطيئة (أيام/أسابيع):
  Truth events accumulate → Calibrator adjusts thresholds
  → PolicyPromoter promotes patterns to policies
  → Future PRs use policies directly
```

## منحنيات التحسن المتوقعة

```
Knowledge Reuse Rate         LLM Calls per PR
    80% ┤ ╔══                1.0 ┤ ╔══
    60% ┤ ║ ╔══              0.8 ┤ ║ ╔══
    40% ┤ ║ ║ ╔══            0.6 ┤ ║ ║ ╔══
    20% ┤ ║ ║ ║ ╔══          0.4 ┤ ║ ║ ║ ╔══
     0% ┤ ║ ║ ║ ║ ║          0.2 ┤ ║ ║ ║ ║ ║
       └───┬───┬───            └───┬───┬───
           v1  شهر 3               v1  شهر 3

Merge Rate                      Cost per PR
   100% ┤ ╔══════             $0.03 ┤ ╔══
    80% ┤ ║                      ────┼──╂───  baseline cost
    60% ┤ ║                    $0.02 ┤ ║ ╔══
                                $0.01 ┤ ║ ║ ╔══
                                 $0 ─┤ ║ ║ ║ ║
                                   └───┬───┬───
                                       v1  شهر 3
```
