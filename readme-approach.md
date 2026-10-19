# README-APPROACH.md

# Alternative Diagnosis Approaches for the VON Fault Diagnosis Project

## 1. Purpose

This document evaluates alternatives to using **VON as the primary
fault-analysis and diagnosis mechanism** in the current project.

The goal is **not** to assume that Machine Learning is automatically
better than VON.

Instead, the objective is to identify other technically suitable
approaches for diagnosing faults from the project's industrial
telemetry, compare their strengths and weaknesses, and identify which
approaches are worth implementing and benchmarking against the existing
VON pipeline.

The five approaches selected for investigation are:

1.  **Bayesian Network / Probabilistic Diagnosis**
2.  **Fuzzy Logic Diagnosis**
3.  **Time-Series Anomaly Detection**
4.  **Case-Based Reasoning (CBR)**
5.  **Time-Series Classification / Machine Learning**

------------------------------------------------------------------------

# 2. Current VON-Based Approach

The current project uses VON as the decision/diagnosis layer after
telemetry is processed and candidate fault evidence is generated.

The simplified flow is:

``` text
Industrial Telemetry
        ↓
Ingestion / Processing
        ↓
Fault Detection
        ↓
Fault Evidence / Episode
        ↓
Retrieval / Machine Knowledge
        ↓
VON Decision / Diagnosis
        ↓
Confidence Gate
        ↓
Ticket / Review / Output
```

The important question is:

> **Can VON be replaced or complemented by a diagnosis method that is
> more deterministic, data-driven, probabilistic, or specifically
> designed for industrial fault diagnosis?**

The answer is yes.

However, there is no universally "best" replacement. The correct choice
depends on:

-   availability of historical fault data
-   quality of fault labels
-   number of fault types
-   explainability requirements
-   ability to encode engineering knowledge
-   ability to detect previously unseen faults
-   inference latency
-   deployment complexity
-   reliability requirements

------------------------------------------------------------------------

# 3. Important Clarification About VON vs ML

It would be inaccurate to say:

> "VON is trained on the wrong parameters."

A general-purpose model is not trained using the same telemetry feature
schema that a supervised fault-classification model would use.

The more accurate distinction is:

> **A domain-specific ML model can be trained directly on the project's
> telemetry features and fault labels, whereas VON does not inherently
> learn the project's machine-specific telemetry-to-fault mapping from
> the project's historical failures.**

VON has an important advantage, however:

-   it can reason over supplied evidence
-   it can use retrieved machine knowledge
-   it can produce natural-language explanations
-   it does not require a large labeled training dataset

Therefore, the comparison should be based on actual experiments rather
than assuming that one approach is automatically superior.

------------------------------------------------------------------------

# 4. Selected Alternatives

## Summary

  -------------------------------------------------------------------------------------------------------
  Approach         Main Idea         Labeled Data   Explainability      Unseen       Domain   Suitability
                                                                     Anomalies    Knowledge 
  ---------------- ----------------- ------------ ---------------- ----------- ------------ -------------
  Bayesian Network Probabilistic       Low/Medium        Excellent      Medium    Excellent    
                   fault reasoning                                                          

  Fuzzy Logic      Reason using                No        Excellent      Medium    Excellent    
                   degrees such as                                                          
                   low/medium/high                                                          

  Anomaly          Learn normal        Usually No           Medium   Excellent          Low    
  Detection        behavior and                                                             
                   detect deviations                                                        

  Case-Based       Compare current        No/Some        Excellent      Medium    Excellent    
  Reasoning        episode with                                                             
                   previous cases                                                           

  Time-Series      Learn fault                Yes           Medium     Limited   Low/Medium      
  Classification / patterns from                                                            
  ML               telemetry windows                                                        
  -------------------------------------------------------------------------------------------------------

------------------------------------------------------------------------

# 5. Approach 1 --- Bayesian Network / Probabilistic Diagnosis

## Concept

A Bayesian Network represents relationships between observations and
possible faults using probabilities.

Example:

``` text
                     Bearing Fault
                    /      |       \
                   /       |        \
                  ↓        ↓         ↓
          High Vibration  High Temp  High Current
```

When telemetry evidence is observed, the system calculates probabilities
such as:

``` text
P(Bearing Fault | Evidence) = 0.81
P(Valve Fault   | Evidence) = 0.11
P(Other Fault   | Evidence) = 0.05
P(Normal        | Evidence) = 0.03
```

## Why it is a strong VON alternative

VON provides reasoning using supplied context.

A Bayesian Network provides a **formal probabilistic diagnostic model**.

Instead of asking a model:

> "What do you think the fault is?"

we explicitly define:

``` text
sensor evidence
       ↓
probabilistic relationships
       ↓
fault probabilities
```

This is easier to validate and reproduce.

## Advantages

-   Highly explainable.
-   Explicit uncertainty.
-   Can combine engineering knowledge and observed telemetry.
-   Does not require massive datasets.
-   Deterministic inference given the same model and evidence.
-   Good fit for fault diagnosis.

## Disadvantages

-   Network structure must be designed carefully.
-   Conditional probabilities must be estimated or supplied.
-   Poor assumptions produce poor results.
-   Continuous telemetry requires suitable modeling/discretization.

## Recommended Python implementation

### pgmpy

Official documentation:

https://pgmpy.org/

GitHub:

https://github.com/pgmpy/pgmpy

Installation:

``` bash
pip install pgmpy
```

pgmpy supports Bayesian Networks, structure learning, parameter
estimation and probabilistic inference.

------------------------------------------------------------------------

# 6. Approach 2 --- Fuzzy Logic Diagnosis

## Concept

Traditional rule-based diagnosis often uses hard thresholds:

``` text
IF vibration > 8
THEN bearing fault
```

This can be too rigid.

Fuzzy logic represents values using degrees:

``` text
Vibration = 7.5

LOW    = 0.05
MEDIUM = 0.65
HIGH   = 0.30
```

A diagnosis can then use rules such as:

``` text
IF vibration is HIGH
AND temperature is HIGH
AND pressure is LOW

THEN bearing fault is VERY LIKELY
```

## Why it is useful as a VON alternative

Industrial telemetry often does not have clean boundaries between:

``` text
Normal
Abnormal
Fault
```

Fuzzy logic allows gradual transitions.

It also allows engineers to encode their knowledge directly.

## Advantages

-   Extremely explainable.
-   No large training dataset required.
-   Good for noisy sensor measurements.
-   Engineering rules are easy to understand.
-   Very low inference cost.
-   Deterministic.

## Disadvantages

-   Membership functions must be designed.
-   Rule bases can become large.
-   Does not automatically discover unknown relationships.

## Recommended implementation

### scikit-fuzzy

Documentation:

https://scikit-fuzzy.github.io/scikit-fuzzy/

GitHub:

https://github.com/scikit-fuzzy/scikit-fuzzy

Installation:

``` bash
pip install -U scikit-fuzzy
```

------------------------------------------------------------------------

# 7. Approach 3 --- Time-Series Anomaly Detection

## Concept

Instead of immediately deciding:

> "Which fault is this?"

the system first asks:

> "Does the current machine behavior significantly differ from normal
> behavior?"

Architecture:

``` text
Historical Normal Telemetry
            ↓
    Learn Normal Behavior
            ↓
       New Telemetry
            ↓
       Anomaly Score
            ↓
      Abnormal Episode
```

Example:

``` text
Anomaly score = 0.10
→ Normal

Anomaly score = 0.92
→ Strong anomaly
```

## Why it is important

Fault data in industrial systems is often scarce.

There may be millions of normal telemetry points but relatively few
confirmed failures.

Anomaly detection can exploit the large amount of normal operating data.

## Algorithms to investigate

-   Isolation Forest
-   One-Class SVM
-   ECOD
-   COPOD
-   Autoencoder
-   LSTM Autoencoder
-   Matrix Profile
-   other multivariate time-series anomaly detectors

## Important limitation

Anomaly detection is **not by itself complete fault diagnosis**.

It can say:

``` text
Something abnormal is happening.
```

It may not be able to say:

``` text
The compressor valve has failed.
```

Therefore, anomaly detection works particularly well as the first stage
of a larger diagnosis pipeline.

## Recommended implementation

### PyOD

Documentation:

https://pyod.readthedocs.io/

GitHub:

https://github.com/yzhao062/pyod

Installation:

``` bash
pip install pyod
```

------------------------------------------------------------------------

# 8. Approach 4 --- Case-Based Reasoning

## Concept

Case-Based Reasoning (CBR) diagnoses a new situation by finding similar
historical situations.

Example:

``` text
Current Fault Episode
        ↓
Extract telemetry features
        ↓
Search historical cases
        ↓
Case #127 → Bearing Failure
Case #203 → Bearing Failure
Case #411 → Bearing Failure
Case #509 → Valve Failure
        ↓
Similarity-weighted result
        ↓
Likely Bearing Failure
```

## Why it is interesting for this project

The current system already works with fault episodes/evidence.

Instead of asking VON to reason about every episode from scratch,
confirmed historical episodes can become a **case database**.

Example case:

``` json
{
  "features": {
    "temperature": 72.4,
    "pressure": 3.2,
    "current": 12.7,
    "vibration": 8.1
  },
  "fault": "bearing_failure",
  "maintenance_action": "bearing_replacement"
}
```

A new episode can be compared against these cases.

## Advantages

-   Highly explainable.
-   No expensive model training.
-   Improves as confirmed cases accumulate.
-   Can show the historical cases supporting a diagnosis.
-   Very suitable for maintenance workflows.

## Disadvantages

-   Requires useful historical cases.
-   Similarity functions must be selected carefully.
-   Poor historical coverage leads to poor diagnosis.
-   A completely new fault may have no useful precedent.

## Recommended implementation

### CBRkit

GitHub:

https://github.com/wi2trier/cbrkit

Installation:

``` bash
pip install cbrkit
```

CBRkit provides case retrieval, similarity measures and case-based
reasoning components.

### CBR-FoX

For a more time-series-oriented CBR implementation:

https://github.com/aaaimx/CBR-FoX

Installation:

``` bash
pip install CBR-FoX
```

This is particularly interesting for multivariate time-series case
similarity.

------------------------------------------------------------------------

# 9. Approach 5 --- Time-Series Classification / Machine Learning

## Concept

Instead of using a general reasoning model, train a model specifically
to recognize telemetry patterns associated with known faults.

Architecture:

``` text
Telemetry Window
       ↓
Feature / Temporal Representation
       ↓
Time-Series Classifier
       ↓
Fault Probabilities
```

Example:

``` text
Bearing Fault = 0.86
Valve Fault   = 0.08
Normal        = 0.06
```

## Why it is a strong alternative

The model can learn the project's actual telemetry-to-fault
relationship.

This is fundamentally different from asking VON to reason from general
model knowledge plus supplied evidence.

## Algorithms worth testing

-   Random Forest
-   XGBoost
-   LightGBM
-   Time Series Forest
-   ROCKET
-   Shapelet classifiers
-   other time-series classifiers

## Recommended framework

### sktime

Documentation:

https://www.sktime.net/

Classification documentation:

https://www.sktime.net/docs/api-reference/classification/

GitHub:

https://github.com/sktime/sktime

Installation:

``` bash
pip install sktime
```

sktime provides dedicated tools for time-series classification and
evaluation.

## Advantages

-   Learns directly from project data.
-   Can capture temporal patterns.
-   Easy to benchmark quantitatively.
-   Fast inference for many classical models.

## Disadvantages

-   Requires reliable labels.
-   Can fail on previously unseen fault types.
-   Requires careful temporal train/test splitting.
-   Less explainable than fuzzy/Bayesian/CBR approaches.
-   A model is only as good as its training data.

------------------------------------------------------------------------

# 10. Which Approach Is Best?

There is no honest answer of:

> "Approach X is definitely better than VON."

The right answer depends on what the project values.

## If explainability is the priority

### Bayesian Network or Fuzzy Logic

Both allow the diagnostic reasoning to be inspected.

------------------------------------------------------------------------

## If labeled data is limited

### Anomaly Detection

It can learn normal machine behavior without requiring a label for every
failure.

------------------------------------------------------------------------

## If historical fault cases are available

### Case-Based Reasoning

The diagnosis can directly reference similar previous failures.

------------------------------------------------------------------------

## If a large reliable fault dataset is available

### Time-Series Classification / ML

This can learn the telemetry-to-fault mapping directly.

------------------------------------------------------------------------

## If uncertainty is important

### Bayesian Network

Probabilistic diagnosis is one of its biggest strengths.

------------------------------------------------------------------------

# 11. Recommended Architecture for Replacing VON

Instead of immediately replacing VON with one method, the best
engineering approach is to create a diagnostic layer that can benchmark
multiple backends.

``` text
                    TELEMETRY
                        ↓
               Existing Detection
                        ↓
                    Episode
                        ↓
              Diagnostic Interface
                        ↓
       ┌────────────────┼─────────────────┐
       │                │                 │
       ▼                ▼                 ▼
 Bayesian           Fuzzy            Anomaly
 Network            Logic            Detector
       │                │                 │
       └────────────────┼─────────────────┘
                        │
                  ┌─────┴─────┐
                  ▼           ▼
                 CBR      Time-Series ML
                  │           │
                  └─────┬─────┘
                        ↓
                 Diagnosis Result
                        ↓
                Confidence Gate
                        ↓
                 Ticket / Review
```

The existing VON backend can remain as another backend during
evaluation:

``` text
Diagnostic Interface
        │
        ├── VON
        ├── Bayesian
        ├── Fuzzy
        ├── Anomaly
        ├── CBR
        └── Time-Series ML
```

This is much better architecturally because the project can compare
approaches without rewriting the entire application.

------------------------------------------------------------------------

# 12. Recommended Evaluation

Each approach should be tested against the same fault scenarios.

Measure:

### Accuracy

How often was the correct fault identified?

### Precision

How many predicted faults were actually correct?

### Recall

How many actual faults were detected?

### F1 Score

Balance between precision and recall.

### False Alarm Rate

How often does the system incorrectly report a fault?

### Detection Lead Time

How early does it identify a developing fault?

### Diagnostic Latency

How long does diagnosis take?

### Explainability

Can the system show why it selected the fault?

### Robustness

Does it remain reliable when sensor values contain noise or missing
values?

### Unknown Fault Handling

Can it identify that something is abnormal even when the exact fault
type is not known?

------------------------------------------------------------------------

# ## 13. Proposed Benchmark

The project should eventually be evaluated using an overall score out of 100, based on the following suggested scoring framework.

### Suggested scoring framework

| Evaluation Factor | Weight |
|---|---:|
| Diagnostic Accuracy | 25 |
| Recall / Fault Detection | 15 |
| F1 Score | 15 |
| False Alarm Rate | 10 |
| Diagnostic Latency | 10 |
| Explainability | 10 |
| Robustness | 10 |
| Unknown-Fault Handling | 5 |
| Total | 100 |

The final score for each method should be calculated only after running the same evaluation dataset and test conditions for every method.

Do not claim a method is better based on this table until the experiments have been performed.


