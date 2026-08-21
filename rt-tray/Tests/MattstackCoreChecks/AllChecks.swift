/// Explicit registry — no reflection. Each *Checks.swift file exposes one
/// array; append it here when you add a file.
let allChecks: [Check] = planModelsChecks + rtClientChecks + readinessModelChecks + permissionsChecks + servicesChecks + sourceGuardChecks + needModelsChecks + trayRoutesChecks + updatePolicyChecks
