# SQLite & Database Center Operations Runbook

Updated: 2026-09-23

คู่มือการดูแลรักษา การเฝ้าระวัง การสำรองข้อมูล และการกู้คืนฐานข้อมูลสำหรับ **SQLite 3 (`better-sqlite3@13.0.3`)** และ **ศูนย์จัดการฐานข้อมูล (Database Center)** บน Owner Dashboard

---

## 1. Storage Quotas & Thresholds (การควบคุมพื้นที่ดิสก์)

ระบบเฝ้าระวังขนาด Footprint รวมของ SQLite (`.sqlite` + `-wal` + `-shm`):

| ระดับสถานะ | ขนาด Footprint | พฤติกรรมและการตอบสนองของระบบ |
| :--- | :--- | :--- |
| **🟢 ปกติ (Normal)** | `< 3.0 GB` | ทำงานตามปกติ รอบการคลีนนิ่งและ Checkpoint ทำตามคาบเวลาปกติ |
| **🟡 ควรตรวจสอบ (Soft Limit)** | `≥ 3.0 GB` | เพิ่มความถี่ในการทำ Bounded Cleanup เบื้องหลัง พร้อมบันทึกแจ้งเตือน |
| **🟠 ใกล้ถึงขีดจำกัด (Critical)** | `≥ 3.6 GB` | ระงับการเขียนแคชใหม่ (Cache Throttled) ล้างข้อมูลแคชและประวัติเก่าเข้มข้นขึ้น |
| **🔴 แตะเพดาน (Hard Limit)** | `≥ 4.0 GB` | **Emergency Write Brake**: ระงับการเขียนแคชและประวัติที่ไม่สำคัญ เพื่อป้องกันดิสก์เต็ม **(ห้ามลบหรือบล็อกข้อมูลหลัก Core Data เด็ดขาด)** |

สามารถปรับแต่งขนาดได้ผ่าน Environment Variables ใน `.env`:
- `SQLITE_QUOTA_SOFT_MB` (ค่าเริ่มต้น: `3000`)
- `SQLITE_QUOTA_CRIT_MB` (ค่าเริ่มต้น: `3600`)
- `SQLITE_QUOTA_HARD_MB` (ค่าเริ่มต้น: `4000`)

---

## 2. Database Center ใน Owner Dashboard (`/database`)

เข้าสู่หน้า Dashboard ผ่านเมนู **🗄️ ฐานข้อมูล** หรือเส้นทาง `/database` (ต้องยืนยันตัวตนด้วย Owner PIN):

- เป็นหน้าแบบ **Single-Page Application (SPA)** สลับเนื้อหาได้ทันทีโดยไม่โหลดหน้าใหม่
- แบ่งออกเป็น 3 แท็บหลัก:
  1. **📊 ภาพรวมระบบ (Overview)**: สรุปสถานะภาพรวมของทั้ง SQLite และ MongoDB, ขนาด Footprint, แถบ Quota, จำนวน Records รวมแยกตามหมวดหมู่, และเวลาการทำบำรุงรักษาล่าสุด
  2. **📁 SQLite (Operational DB)**: รายละเอียดเครื่องยนต์ SQLite (WAL mode, Foreign keys, Schema version), ตารางแยกหมวดหมู่ (Core, Temp, History, Cache), ปุ่มสั่งการบำรุงรักษา (Integrity, Cleanup, Vacuum, Backup) และ **Database Console**
  3. **🍃 MongoDB (Identity & Security)**: สถานะคลัสเตอร์, Ping latency, รายการ Collections และ **Safe Data Explorer** สำหรับดูตัวอย่างข้อมูลแบบ Masked/Redacted ปลอดภัย

### 🔒 ข้อกำหนดความปลอดภัยของ Database Console
คอนโซลในหน้าเว็บอนุญาตให้รันเฉพาะคำสั่ง Allowlist ฐานข้อมูลเท่านั้น:
- `status`, `health` — ตรวจสอบสถานะภาพรวมและสุขภาพฐานข้อมูล
- `stats` — ดูสถิติแถวข้อมูลแยกตามหมวดหมู่ (Core, Temp, History, Cache)
- `tables` — แสดงรายชื่อตารางทั้งหมดพร้อมจำนวนแถว
- `migrations` — ดูประวัติ Schema Migrations และเวอร์ชันปัจจุบัน
- `integrity` — ตรวจสอบความสมบูรณ์เชิงลึกของข้อมูล (PRAGMA integrity_check)
- `cleanup`, `cleanup cache`, `cleanup history` — สั่งล้างข้อมูลหมดอายุ แคช หรือประวัติย้อนหลัง
- `checkpoint` — รวมไฟล์ WAL กลับเข้าสู่ไฟล์หลัก
- `vacuum` — รัน Incremental Vacuum คืนพื้นที่ที่ว่าง
- `backup` — สร้างไฟล์สำรองข้อมูลทันที

> [!CAUTION]
> **ระบบบล็อกคำสั่ง OS Shell (เช่น `rm`, `curl`, `wget`, `bash`) 100%**: เพื่อความปลอดภัยสูงสุด ห้ามเปิดใช้ Arbitrary OS Shell จากหน้าเว็บ

---

## 3. ชุดคำสั่ง CLI มาตรฐาน (`npm run db:sqlite:*`)

ผู้ดูแลระบบสามารถสั่งการผ่าน Terminal ได้โดยตรง โดยระบบ CLI จะเรียกผ่าน `DatabaseService` เดียวกันกับหน้าเว็บ:

| คำสั่ง NPM | สคริปต์ที่รัน | หน้าที่และการทำงาน |
| :--- | :--- | :--- |
| `npm run db:sqlite:status` | `scripts/db/status.js` | แสดงสถานะสรุปของทั้ง SQLite และ MongoDB เป็นภาษาไทย |
| `npm run db:sqlite:stats` | `scripts/db/stats.js` | แสดงสถิติและจำนวนแถวแยกตามหมวดหมู่ Core, Temp, History, Cache |
| `npm run db:sqlite:check` | `scripts/db/checkSqlite.js` | ตรวจสอบไฟล์, PRAGMAs, Migrations, Read/Write probe และ Quota |
| `npm run db:sqlite:integrity` | `scripts/db/integrity.js` | ตรวจสอบความสมบูรณ์เชิงลึกและ Foreign Key Constraints |
| `npm run db:sqlite:cleanup` | `scripts/db/cleanup.js` | ทำความสะอาดข้อมูลหมดอายุและประวัติเก่าตาม Retention Policy |
| `npm run db:sqlite:backup` | `scripts/db/backupSqlite.js` | สำรองข้อมูล SQLite แบบ Online (เก็บ 2 ชุดล่าสุด ตรวจพื้นที่ว่างก่อนทำ) |
| `npm run db:sqlite:restore` | `scripts/db/restoreSqlite.js` | กู้คืนฐานข้อมูลจากไฟล์แบ็กอัป พร้อมระบบตรวจ Integrity และสร้าง Rollback `.bak` |
| `npm run db:sqlite:migrate` | `scripts/db/migrate.js` | ตรวจสอบและรัน Schema Migrations ที่ค้างอยู่ |

---

## 4. นโยบายการสำรองข้อมูลและการกู้คืน (Backup & Restore Policy)

1. **Online Non-blocking Backup**:
   - ใช้ SQLite Native Backup API ไม่ล็อกระบบ บอททำงานต่อได้ตามปกติ
   - **การจำกัดจำนวนชุด (Rotation)**: เก็บไฟล์สำรองในเครื่องเพียง **2 ชุดล่าสุด** เป็นค่าเริ่มต้น เพื่อประหยัดพื้นที่ดิสก์
   - **การตรวจพื้นที่ว่าง (Disk Free Space Check)**: ตรวจสอบพื้นที่ว่างของ Filesystem ก่อนเริ่ม Backup เสมอ (ต้องมีที่ว่างอย่างน้อย 1.5 เท่าของขนาดฐานข้อมูล) หากไม่พอจะยกเลิกทันทีเพื่อป้องกันดิสก์เต็ม
2. **Safe Restore Safeguards**:
   - คำสั่ง: `node scripts/db/restoreSqlite.js --source ./backups/sqlite_backup_<timestamp>.sqlite`
   - ตรวจสอบ `PRAGMA integrity_check` ของไฟล์สำรองก่อนเริ่มแตะต้องฐานข้อมูลจริง
   - สร้างไฟล์สำรองย้อนกลับ (`.pre-restore-<timestamp>.bak`) ของฐานข้อมูลเดิมอัตโนมัติ
   - ลบไฟล์ `-wal` และ `-shm` เดิมทิ้งเพื่อป้องกันการ Replay Log ทับไฟล์ใหม่
   - ตรวจสอบความสมบูรณ์หลังการกู้คืนเสร็จสิ้น

---

## 5. การแก้ปัญหาเมื่อเกิดเหตุฉุกเฉิน (Troubleshooting)

### ปัญหาที่ 1: ไฟล์ WAL มีขนาดใหญ่ผิดปกติ (> 500MB)
- **สาเหตุ**: มี Transaction อ่านค้างอยู่ หรือมี Concurrency สูงทำให้ Checkpoint แบบ PASSIVE รวมไฟล์ไม่สำเร็จ
- **วิธีแก้**:
  ```bash
  npm run db:sqlite:check
  ```
  หรือสั่ง Checkpoint ทันที:
  ```bash
  node -e "const { getDatabase } = require('./database/sqlite/connection'); getDatabase().pragma('wal_checkpoint(TRUNCATE)');"
  ```

### ปัญหาที่ 2: พื้นที่ดิสก์ใกล้เต็ม (เข้าสู่สถานะ Critical หรือ Hard Limit)
- **วิธีแก้**:
  1. สั่งรันคำสั่งทำความสะอาดข้อมูล:
     ```bash
     npm run db:sqlite:cleanup
     ```
  2. รัน Incremental Vacuum เพื่อคืนพื้นที่:
     ```bash
     node -e "const { getDatabase } = require('./database/sqlite/connection'); const { runIncrementalVacuum } = require('./database/sqlite/maintenance/vacuum'); runIncrementalVacuum(getDatabase(), 1000);"
     ```
  3. ตรวจสอบพื้นที่อีกครั้งด้วย `npm run db:sqlite:stats`
