# CEU Tracker API Documentation

This document describes the REST API endpoints available in the CEU Tracker application.

## Base URL

- Development: `http://localhost:3000`
- Production: Deployed via Vercel (auto-publishes from git push)

---

## Express Server Endpoints (`server.js`)

### `GET /`

Returns the main compliance dashboard HTML page.

**Response:**
- `200 OK` - HTML dashboard page
- `404 Not Found` - Dashboard not generated yet (run `npm start` first)

---

### `GET /cmo`

Returns the CMO (Chief Medical Officer) executive dashboard.

**Response:**
- `200 OK` - CMO dashboard HTML page
- `404 Not Found` - CMO dashboard file not found

---

### `GET /api/history`

Returns the full run history for all scraping sessions.

**Response:**
```json
[
  {
    "timestamp": "2024-03-15T22:30:00.000Z",
    "succeeded": 15,
    "failed": 2,
    "notConfigured": 3,
    "loginErrors": [
      {
        "name": "Provider Name",
        "errorCode": "invalid_credentials",
        "error": "Invalid username or password",
        "errorAction": "Contact provider to verify their CE Broker login credentials"
      }
    ],
    "providers": [
      {
        "name": "John Doe",
        "state": "Florida",
        "hoursRequired": 24,
        "hoursCompleted": 18,
        "hoursRemaining": 6,
        "renewalDeadline": "06/30/2025"
      }
    ]
  }
]
```

---

### `GET /api/status`

Returns the last run summary.

**Response:**
```json
{
  "timestamp": "2024-03-15T22:30:00.000Z",
  "total": 20,
  "succeeded": 15,
  "failed": 2
}
```

If no runs have occurred yet:
```json
{
  "error": "No run data yet. Run npm start to scrape."
}
```

---

## Next.js API Endpoints (`nextjs-app/src/app/api/`)

### `GET /api/providers`

Returns a list of all providers with their compliance status.

**Query Parameters:**
- `limit` (number) - Maximum number of providers to return (default: 100)
- `status` (string) - Filter by status: "Complete", "At Risk", "In Progress", "Unknown"
- `sortBy` (string) - Sort field: "name", "deadline", "hours"

**Response:**
```json
{
  "data": [
    {
      "id": "provider-1",
      "name": "John Doe",
      "type": "NP",
      "state": "Florida",
      "licenseType": "Nurse Practitioner",
      "renewalDeadline": "2025-06-30",
      "hoursRequired": 24,
      "hoursCompleted": 18,
      "hoursRemaining": 6,
      "status": "In Progress"
    }
  ],
  "total": 20
}
```

---

### `GET /api/providers/[id]`

Returns details for a specific provider.

**Response:**
```json
{
  "id": "provider-1",
  "name": "John Doe",
  "type": "NP",
  "state": "Florida",
  "licenseType": "Nurse Practitioner",
  "licenseNumber": "NP12345",
  "renewalDeadline": "2025-06-30",
  "hoursRequired": 24,
  "hoursCompleted": 18,
  "hoursRemaining": 6,
  "status": "In Progress",
  "subjectAreas": [
    {
      "topicName": "Pharmacology",
      "hoursRequired": 6,
      "hoursCompleted": 4,
      "hoursNeeded": 2
    }
  ],
  "completedCourses": [
    {
      "name": "Advanced Pharmacology",
      "hours": 4,
      "date": "2024-01-15",
      "category": "Pharmacology"
    }
  ]
}
```

---

### `GET /api/predictions`

Returns compliance risk predictions for all providers.

**Response:**
```json
{
  "predictions": [
    {
      "providerId": "provider-1",
      "providerName": "John Doe",
      "riskScore": 75,
      "riskLevel": "high",
      "factors": [
        "6 hours remaining with 90 days to deadline",
        "No courses completed in last 30 days"
      ],
      "recommendation": "Needs to complete 2 hours per month to meet deadline"
    }
  ],
  "summary": {
    "highRisk": 3,
    "mediumRisk": 5,
    "lowRisk": 12
  }
}
```

---

### `GET /api/risk`

Returns aggregated risk statistics.

**Response:**
```json
{
  "overall": {
    "averageRisk": 35,
    "highRiskCount": 3,
    "mediumRiskCount": 5,
    "lowRiskCount": 12
  },
  "byState": {
    "Florida": { "average": 40, "count": 8 },
    "Texas": { "average": 25, "count": 6 }
  },
  "trend": {
    "improving": 10,
    "stable": 5,
    "declining": 5
  }
}
```

---

### `GET /api/alerts`

Returns active compliance alerts.

**Response:**
```json
{
  "alerts": [
    {
      "id": "alert-1",
      "type": "deadline",
      "severity": "high",
      "providerId": "provider-1",
      "providerName": "John Doe",
      "message": "Renewal deadline in 30 days with 6 hours remaining",
      "createdAt": "2024-03-15T10:00:00.000Z"
    }
  ],
  "summary": {
    "high": 3,
    "medium": 5,
    "low": 2
  }
}
```

---

### `GET /api/health`

Returns application health status.

**Response:**
```json
{
  "status": "healthy",
  "timestamp": "2024-03-15T22:30:00.000Z",
  "lastScrape": "2024-03-15T22:00:00.000Z",
  "database": "connected",
  "version": "1.0.0"
}
```

---

## Error Codes

The scraper classifies login errors into these categories:

| Code | Description | User Action |
|------|-------------|-------------|
| `invalid_credentials` | Wrong username or password | Verify CE Broker login credentials |
| `account_locked` | Account locked or disabled | Contact CE Broker support |
| `mfa_required` | Two-factor authentication required | Disable 2FA or configure workaround |
| `timeout` | Page took too long to respond | Will retry automatically |
| `site_changed` | CE Broker page structure changed | Contact support for scraper update |
| `network_error` | Network connection failed | Check internet connection |
| `session_error` | Login session failed | Will retry automatically |
| `unknown` | Unrecognized error | Check screenshot for details |

---

## Authentication

Currently, the API does not require authentication. For production deployment, consider adding:

- API key authentication for programmatic access
- Session-based authentication for dashboard access
- OAuth integration for enterprise deployments

---

## Rate Limiting

The scraper includes built-in rate limiting:

- **Between providers:** 3-7 second random delay
- **Between batches:** 2-4 second delay
- **Retry backoff:** Exponential (2s, 4s, 8s with jitter)
- **Max retries:** 3 attempts per operation

---

## Data Files

The API reads from these data files:

| File | Description |
|------|-------------|
| `history.json` | Run history with snapshots |
| `last_run.json` | Most recent run summary |
| `course-history.json` | Provider course completion history |
| `credential-health.json` | Credential status tracking |
| `platform-data.json` | Platform scraping results |
| `costs.json` | Cost tracking data |
