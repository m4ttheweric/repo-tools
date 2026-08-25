---
name: stage-ship
description: "stage-ship"
type: pipeline-step
metadata:
  stage: ship
  stage-consumes: commits ticket
  stage-produces: mr
---

{{stage.fields}}
