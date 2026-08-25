---
name: stage-plan
description: "stage-plan"
type: pipeline-step
slots:
  domain: { contract: "plan-domain@1", required: false }
metadata:
  stage: plan
  stage-consumes: ticket
  stage-produces: approach
---

{{stage.fields}}
{{slot:domain}}
