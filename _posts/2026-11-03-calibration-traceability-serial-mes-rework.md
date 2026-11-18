---
layout: post
title: "產線校正資料沒綁序號？MES traceability 與 DDC/CI 寫入持久化的三個坑"
date: 2026-11-03
tags: [DDC/CI, MES, traceability, factory-calibration, Python]
level: intermediate
prerequisites: ["DDC/CI 與 MCCS 入門：用 ddcutil 控制顯示器", "產線白平衡校正閉式解：RGB gain 收斂與 DDC/CI 寫入時序"]
series: "從零成為顯示器架構師"
topic_track: C
roadmap_stage: practitioner
sources_checked: 2026-11-03
difficulty: intermediate
---
## 前置知識

產線白平衡校正站就像餐廳出菜前的最後檢查：色度儀（colorimeter，例如 Konica Minolta CA-410）量測螢幕的白點，Python 腳本透過 DDC/CI（Display Data Channel Command Interface，顯示器控制命令介面）把 RGB gain 寫進 scaler，然後希望這台機器出廠時顏色是對的。

這裡有三個新手容易混淆的概念：

1. **DDC/CI 與 MCCS**：DDC/CI 是透過 I2C 匯流排跟顯示器溝通的協定，MCCS（Monitor Control Command Set，顯示器控制命令集）則定義了可以讀寫哪些功能（VCP，Virtual Control Panel 代碼，例如亮度 0x10、輸入源 0x60、紅綠藍增益 0x16／0x18／0x1A）。ddcutil 是 Linux 上常用的 DDC/CI 工具，已查證（來源：ddcutil 官方文件 https://www.ddcutil.com/commands/）。
2. **setvcp 只拿到 I2C ACK**：ddcutil 發送 Set VCP Feature 封包後，顯示器只回「我收到了」，並不代表面板端已經執行並存進非揮發性記憶體（NVRAM）。要求顯示器存檔要另外送 DDC/CI 的 Save Current Settings 命令（ddcutil 的 scs）。注意它是獨立的 DDC/CI 命令，不是 VCP 代碼；VCP 0xD6 是 Power Mode（電源模式），寫錯會讓螢幕進休眠（已查證：https://www.ddcutil.com/command_scs/、https://www.ddcutil.com/vcpinfo_output/）。ddcutil 文件也提醒：有些顯示器不支援 scs，多數支援的機型送了也看不出效果，是否真的寫進 NVRAM 要以斷電重開後讀回為準。
3. **Traceability（追溯性）**：產線上的每一台機器都有序號（SN），校正結果（RGB gain、ΔE、色溫、量測儀器序號）必須與 SN 綁定，上傳到 MES（Manufacturing Execution System，製造執行系統）。以後該台機器 RMA 回廠或需要 rework，工程師才能透過 SN 查到原始校正參數，判斷是面板老化還是校正站問題。

## 技術核心

### 根因分析

情境模擬（依公開規格推演）：某產線白平衡校正站完成一台顯示器的 RGB gain 校正後，Python 腳本只把結果寫進本地 log 檔，沒有與 DUT 序號綁定，也沒有上傳 MES。導致 rework 時找不到原始校正值，只能重新全量校正，takt time 被拉長，且無法區分是否為同一批面板的系統性漂移。

根因有三：

1. **校正資料與 SN 脫鉤**：腳本取得 DUT 序號後只寫本地 log，未與 DDC/CI 寫入的 RGB gain 值做關聯。同一台機器重複校正時，舊資料被覆蓋，無法追溯校正歷史。
2. **MES 上傳缺失**：校正完成後沒有將 {SN, RGB_gain_R/G/B, color_temperature, deltaE, instrument_id, timestamp, fw_version} 上傳到 MES。MES 端無法做 SPC（Statistical Process Control，統計製程控制）監控，rework 時也無法下載歷史校正值。
3. **DDC/CI 寫入未確認持久化**：setvcp 只拿到 I2C ACK，不等於面板端已執行並存入 NVRAM。若未送 scs（Save Current Settings），斷電後校正值遺失，traceability 資料與實際出廠狀態不符。

### 修正程式碼

以下為 Python 自動化腳本示意。DDC/CI 相關指令（ddcutil getvcp/setvcp/scs）已查證（來源：ddcutil 官方文件 https://www.ddcutil.com/command_setvcp/、https://www.ddcutil.com/command_scs/）；RGB gain 用 MCCS 公開定義的 0x16／0x18／0x1A（Video Gain Red／Green／Blue，已查證：https://www.ddcutil.com/vcpinfo_output/；VESA MCCS 2.2a 公開鏡像 Table 8-4，PDF p.34–39）；廠商自訂碼或非公開 scaler 暫存器地址則標註 `# 示意地址，非實際晶片規格`，需對照手上的 scaler NDA datasheet。

```python
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Factory calibration traceability script.
Controls colorimeter (CA-410) and DDC/CI (via ddcutil) for white balance
calibration, binds calibration data to DUT serial number, uploads to MES.
"""

import subprocess
import json
import sys
import hashlib
from datetime import datetime, timezone
from pathlib import Path

# --- 設定（示意，依實際產線調整）---
DDC_BUS = 1                     # ddcutil --bus 吃 I2C 匯流排編號（/dev/i2c-1 → 1），示意值
CA410_SERIAL = "CA410-20260001" # 色度儀序號
MES_UPLOAD_URL = "https://mes.example.com/api/calibration/upload"  # 待查證：廠內 MES API
FW_VERSION = "1.0.3"

# VCP 代碼（MCCS 公開定義，ddcutil 文件已查證）
VCP_BRIGHTNESS = 0x10
VCP_INPUT_SOURCE = 0x60
# 注意：Save Current Settings 是 DDC/CI 命令（ddcutil scs），不是 VCP 代碼；
# 0xD6 是 Power Mode，千萬不要拿來 setvcp。

# RGB gain VCP 代碼（MCCS 公開定義 Video Gain，ddcutil vcpinfo 已查證）
# 0x62／0x64／0x66 分別是喇叭音量、麥克風音量、環境光感測器，不是 RGB gain。
VCP_RED_GAIN = 0x16
VCP_GREEN_GAIN = 0x18
VCP_BLUE_GAIN = 0x1A


def run_ddcutil(args, check=True):
    """執行 ddcutil 指令。DDC/CI 指令已查證（ddcutil 官方文件）。"""
    # --bus 與 --display 都是「選螢幕」的選項，只用一個
    cmd = ["ddcutil", "--bus", str(DDC_BUS)] + args
    result = subprocess.run(cmd, capture_output=True, text=True)
    if check and result.returncode != 0:
        raise RuntimeError(f"ddcutil {' '.join(args)} failed: {result.stderr}")
    return result.stdout.strip()


def get_dut_serial():
    """從 EDID 序號區塊或 UART debug console 讀取 DUT 序號。
    EDID serial number 在 Base EDID Block 0，byte 12-15（VESA E-EDID 1.4，頁碼待查證）。
    注意：不少機型的 EDID 數字序號是 0 或同型號共用，不能直接當主鍵。
    UART 讀取部分為示意，需對照 scaler SDK（待查證）。"""
    output = run_ddcutil(["detect", "--brief"])
    # 實際需解析 EDID serial number，此處示意回傳
    return "DUT-20261103-0042"


def set_rgb_gain_via_ddcci(r, g, b):
    """透過 DDC/CI 寫入 RGB gain、送 scs，再逐一讀回比對。
    setvcp／getvcp／scs 已查證（ddcutil 官方文件）。"""
    targets = {VCP_RED_GAIN: r, VCP_GREEN_GAIN: g, VCP_BLUE_GAIN: b}
    for code, val in targets.items():
        # 失敗就丟例外，不要吞掉錯誤
        run_ddcutil(["setvcp", f"{code:02x}", str(val)])
    # 要求顯示器存檔（DDC/CI Save Current Settings；不支援的機型會報錯）
    run_ddcutil(["scs"])
    readback = {}
    for code, val in targets.items():
        # --terse 輸出格式示例：VCP 16 C 50 100（最後兩欄是目前值、最大值；格式待實機確認）
        out = run_ddcutil(["getvcp", f"{code:02x}", "--terse"])
        cur = int(out.split()[3])
        if cur != val:
            raise RuntimeError(f"VCP 0x{code:02X} 讀回 {cur}，目標 {val}")
        readback[code] = cur
    return readback[VCP_RED_GAIN], readback[VCP_GREEN_GAIN], readback[VCP_BLUE_GAIN]


def compute_params_hash(record):
    """將校正資料雜湊，作為 traceability 指紋，用來發現資料被意外改動。
    注意：沒有金鑰的雜湊任何人都能重算，防不了刻意竄改；要防竄改需用 HMAC 或簽章。"""
    payload = json.dumps(record, sort_keys=True).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()[:16]


def main():
    dut_sn = get_dut_serial()
    print(f"[INFO] DUT SN: {dut_sn}")

    # 量測白平衡（CA-410，數值需依實際儀器實測，此處為示意）
    meas = {"x": "待查證", "y": "待查證", "cct_k": "待查證", "deltaE": "待查證",
            "instrument_id": CA410_SERIAL,
            "measured_at": datetime.now(timezone.utc).isoformat()}

    # 計算目標 RGB gain（閉式解或查表，示意值；上限以 getvcp 回報的最大值為準，常見是 100）
    target_gain = {"r": 90, "g": 88, "b": 85}

    # 透過 DDC/CI 寫入 RGB gain 並持久化
    rb, gb, bb = set_rgb_gain_via_ddcci(target_gain["r"], target_gain["g"], target_gain["b"])

    # 組裝校正紀錄
    calibration_record = {
        "sn": dut_sn,
        "fw_version": FW_VERSION,
        "instrument_id": CA410_SERIAL,
        "measurement": meas,
        "target_gain": target_gain,
        "ddc_readback": {"red": rb, "green": gb, "blue": bb},
        "calibrated_at": datetime.now(timezone.utc).isoformat(),
        "params_hash": compute_params_hash({
            "sn": dut_sn, "measurement": meas, "target_gain": target_gain,
        }),
    }

    # 本地存檔（traceability 備份）
    log_dir = Path(f"/var/log/factory/calibration/{dut_sn}")
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = log_dir / f"{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    log_file.write_text(json.dumps(calibration_record, ensure_ascii=False, indent=2), encoding="utf-8")

    # 上傳 MES（MES API 端點與認證方式為廠內規定，待查證）
    print(f"[MES UPLOAD] {json.dumps(calibration_record, ensure_ascii=False)}")
    print("[INFO] Calibration traceability complete.")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"[ERROR] Calibration failed: {exc}", file=sys.stderr)
        sys.exit(1)
```

關鍵修正點：

- **setvcp 後送 scs（DDC/CI Save Current Settings，不是 VCP 代碼）**：ddcutil 文件已查證，有使用者回報部分 Iiyama 機型（PL2492H、PL2792Q）在送 scs 之前，setvcp 的值不會真正生效；這類機型的 setvcp 要加 `--noverify`，否則內建驗證會讀到舊值而失敗。
- **setvcp 後 getvcp 讀回比對**：ddcutil 的 setvcp 預設會自己讀回驗證，可用 `--noverify` 跳過以提升效能。traceability 場景建議腳本再讀回一次並和目標值比對，把讀回值寫進紀錄；只把 getvcp 的輸出存起來不算驗證。
- **出廠前抽測斷電重開**：scs 有沒有真的寫進 NVRAM，只能靠斷電重開後讀回確認。
- **校正紀錄與 SN 1:1 綁定，不覆蓋歷史**：同一 SN 多次校正時，每次都存成新檔案，保留完整校正歷史，方便 rework 對照。
- **params_hash 當指紋**：用 SHA-256 雜湊校正資料，rework 時可比對資料有沒有被意外改動。要防刻意竄改，請改用 HMAC（金鑰放在 MES 端）或數位簽章。

## 真實血淚案例

情境模擬（依公開規格推演），非真實客戶或產品事件。

某產線夜班發現一批 27 吋顯示器客退，症狀是「白色偏紅」。工程師拿到機器後想查原始校正值，發現校正站只存了當天的 log，沒有與序號綁定，也沒上傳 MES。rework 時只能從頭重校，但重校後的 ΔE 與出廠時相比，無法判斷漂移是來自面板老化、背光模組更換，還是校正站色度儀本身漂移。

更糟的是，校正腳本只做了 setvcp 沒送 scs。部分機器在出廠測試時顏色正確，但客戶使用幾天後斷電重開，顏色又偏回去了——因為 RGB gain 沒有持久化到 NVRAM。這批機器最終造成大量客退，8D 報告的根因被寫成「校正站流程缺失：缺乏 traceability 與 DDC/CI 持久化確認」。

## 新人避坑指南

1. **不要把 I2C ACK 當成執行成功**：setvcp 收到 ACK 只代表匯流排層收到封包，不代表 scaler 已執行。寫入色彩類參數（RGB gain、色溫）後，送 scs（Save Current Settings）並 getvcp 讀回比對目標值。
2. **校正資料必須與序號綁定**：沒有 SN 綁定的校正紀錄等於沒紀錄。rework 時找不到原始值，只能全量重校，takt time 會被拉長，且無法做 SPC 漂移監控。
3. **本地 log 與 MES 上傳雙重保險**：MES 網路中斷時，本地先存檔，補傳機制需另行實作。不要只依賴 MES，否則網路一斷整條產線就停。
4. **色度儀序號也要記下來**：CA-410 等色度儀有校驗週期，儀器本身可能漂移。校正紀錄要綁定儀器序號，以後發現色差異常時可以回溯是哪支儀器量的。
5. **VCP 代碼先查表再寫**：RGB gain 是 0x16／0x18／0x1A，0x62 是喇叭音量、0xD6 是電源模式，寫錯碼不會報錯，只會動到別的功能。可先用 `ddcutil vcpinfo` 與 `ddcutil capabilities` 確認。廠商自訂碼（0xE0–0xFF）或 scaler 暫存器地址若非出自公開 datasheet，必須註解 `# 示意地址，非實際晶片規格`，量產前對照手上的 scaler NDA 文件確認。

## 思考題

EDID Base Block 0 的序號區塊（byte 12-15）與 DDC/CI 的 VCP 代碼空間，哪一個更適合作為產線 traceability 的主鍵？為什麼？

<details>
<summary>提示（點擊展開）</summary>
EDID 序號在出廠時就寫入，不隨韌體升級改變；但部分 scaler 可能不正確填寫 EDID 序號。DDC/CI VCP 則需要顯示器通電且 I2C 通路正常才能讀寫。兩者各有優劣，實際產線常兩者並用。
</details>

## 參考資料

1. ddcutil Command Overview（官方文件）：https://www.ddcutil.com/commands/ — ddcutil detect/capabilities/getvcp/setvcp/scs 指令說明（已查證）
2. ddcutil setvcp 命令細節（官方文件）：https://www.ddcutil.com/command_setvcp/ — setvcp 語法、--noverify 選項、VCP 0x60 Input Source（已查證）
3. ddcutil scs 命令細節（官方文件）：https://www.ddcutil.com/command_scs/ — Save Current Settings 指令；文件說明部分顯示器不支援、多數送了也無明顯效果，少數 Iiyama 機型需要 scs 才生效（已查證）
4. ddcutil vcpinfo 輸出（官方文件）：https://www.ddcutil.com/vcpinfo_output/ — 0x16／0x18／0x1A Video Gain、0x62 喇叭音量、0x64 麥克風音量、0x66 環境光感測器、0xD6 Power Mode（已查證；VESA MCCS 2.2a 公開鏡像 https://milek7.pl/ddcbacklight/mccs.pdf ：16h／18h／1Ah 在 PDF p.27、p.34–39，62h 在 p.29、p.90，D6h 在 p.70）
5. ddcutil 介紹頁（官方文件）：https://www.ddcutil.com/ — DDC/CI 透過 I2C 通訊、MCCS 規格、/dev/i2c-* 裝置節點（已查證）
6. ArgyllCMS 官方網站：https://www.argyllcms.com/ — 開源色彩管理系統，spotread 工具（版本號與 CA-410 支援待查證）
