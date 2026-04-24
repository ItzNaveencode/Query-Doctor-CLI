# 🚑 QueryDoctor CLI — Fix Slow PostgreSQL Queries Instantly

Stop guessing why your database is slow.  
QueryDoctor detects the root cause and gives you a safe, production-ready fix in seconds.

---

## ⚡ Demo

bash querydoctor diagnose --db "postgres://localhost:5432/postgres" 

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 🚨 PRIMARY ISSUE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  Problem: This query performs a full table scan due to a missing index on users.created_at.  Action: CREATE INDEX CONCURRENTLY idx_users_created_at ON users(created_at);  Why: The database is scanning the entire table instead of using an index.  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  🔥 Confidence: HIGH (clear missing index detected)

---

## 🚨 The Problem

When your app slows down:

- You see alerts in Datadog / logs  
- You open EXPLAIN ANALYZE  
- You spend hours guessing what’s wrong  

👉 Most teams don’t have a DBA

---

## 💡 The Solution

QueryDoctor acts like a DBA in your terminal:

- Finds the most impactful slow query  
- Identifies the root cause  
- Proves the fix  
- Gives copy-paste SQL  

---

## 🧠 How It Works

pg_stat_statements → QueryDoctor → Diagnosis → Fix

1. Detects slow queries from database stats  
2. Analyzes execution plan (JSON format)  
3. Simulates fixes using HypoPG (no real changes)  
4. Outputs the safest production-ready solution  

---

## 🚀 Installation

Run instantly (no install needed):

bash npx querydoctor diagnose --db "postgres://localhost:5432/postgres" 

Or install globally:

bash npm install -g querydoctor querydoctor diagnose --db "postgres://localhost:5432/postgres" 

---

## 🛠 Usage

bash querydoctor diagnose --db "<your_database_url>" 

Or use environment variable:

bash DATABASE_URL="postgres://localhost:5432/postgres" querydoctor diagnose 

---

## 🔍 What It Detects

- Missing indexes (Seq Scan)
- Slow ORDER BY queries
- Inefficient LIKE patterns
- Basic query performance issues

---

## ⚠️ Smart Recommendations

QueryDoctor avoids dangerous mistakes:

- Uses CREATE INDEX CONCURRENTLY (no table locks)
- Detects wildcard LIKE and suggests trigram indexes
- Skips unsafe or unclear recommendations

---

## 🔒 Safety

- ✅ Read-only analysis  
- ✅ Uses hypothetical indexes (HypoPG)  
- ✅ No data leaves your system  
- ✅ Zero-trust architecture  

---

## 💥 Why QueryDoctor

| Traditional Tools | QueryDoctor |
|------------------|------------|
| Show metrics | Gives exact fix |
| Requires DBA knowledge | Beginner-friendly |
| Dashboards | Instant CLI result |
| Guessing | Deterministic output |

---

## 🧪 Example Cases

### ORDER BY issue
sql SELECT * FROM users ORDER BY created_at; 

👉 Suggests index on created_at

---

### LIKE wildcard issue
sql SELECT * FROM users WHERE email LIKE '%gmail.com'; 

👉 Suggests trigram index with explanation

---

## 📌 Roadmap

- [ ] ORM-aware fixes (Prisma, Hibernate)
- [ ] Migration file generation
- [ ] MCP integration (AI assistants)
- [ ] Advanced DB health checks

---

## 🤝 Contributing

Contributions are welcome. Open issues or PRs.

---

## 📄 License

MIT License

---

## 👨‍💻 Author

Built by Naveen
