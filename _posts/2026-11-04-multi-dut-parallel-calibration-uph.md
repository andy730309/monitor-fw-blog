---
layout: post
title: "四台螢幕一起校反而更慢？多 DUT 並行校正站的排程、儀器鎖與 UPH 瓶頸數學"
date: 2026-11-04
tags: [factory-calibration, UPH, DDC/CI, CA-410, Python, scheduling]
level: intermediate
prerequisites: ["DDC/CI 與 MCCS 入門：用 ddcutil 從電腦控制顯示器", "白平衡校正迭代震盪、複驗就翻船？閉式解的數學域、儀器精度與 DDC/CI 寫入時序三個坑", "產線校正資料沒綁序號？MES traceability 與 DDC/CI 寫入持久化的三個坑"]
series: "從零成為顯示器架構師"
topic_track: C
roadmap_stage: practitioner
sources_checked: 2026-11-04
description: "四台螢幕一起校正反而更慢？拆解多 DUT 並行校正站的儀器互斥鎖、DUT 綁定、pipeline 排程與 UPH 瓶頸數學。"
seo_title: "多 DUT 並行校正反而更慢？儀器鎖與 UPH"
difficulty: intermediate
---
> **重點摘要**：多 DUT 並行時，色度儀是共用資源，一次只能量一台，沒有互斥鎖就會量到隔壁工位的畫面。修正方法是把量測段變成唯一的 critical section，用不會漂移的方式綁定 DUT，並用 pipeline 排程。整站產能由瓶頸段的時間決定。

## 前置知識

先把校正站想成一間只有一台烤箱的烘焙坊。四個師傅（四台 DUT）同時開工，但麵團進烤箱（色度儀量測）一次只能一批，而且烤箱的旋鈕（儀器的命令介面）只有一組——兩個師傅同時伸手轉旋鈕，烤出來的東西是誰的配方都說不清。並行化的重點從來不是「人多好辦事」，而是搞清楚哪一段是烤箱、哪一段是揉麵團。

本篇會用到的三個概念：

1. **UPH 與 takt**：UPH（Units Per Hour，每小時產出台數）是產線的產能語言；takt time 是「平均每台可用的工作秒數」。兩者是倒數關係，瓶頸段的時間決定整站 takt。
2. **DDC/CI 的等待成本**：DDC/CI（Display Data Channel Command Interface，顯示器控制命令介面）規格要求 host 在送命令與讀回應之間等待 40–200 ms（依操作而定）；ddcutil 遵守規格時，大約 90% 的執行時間花在等待上（來源：ddcutil 官方文件 Performance and Tuning Options 頁）。這段等待期間，色度儀是閒的——這就是並行化可以偷的時間。
3. **共享儀器**：Konica Minolta CA-410 這類色度儀透過 USB 或 RS-232C 與電腦通訊（官方 datasheet），命令是序列制的：先送 `COM,[1]` 進 remote mode，做完量測再 `COM,0` 退出（來源：CA-410 Communication Specifications Ver 1.08，PDF p.24）。一條命令流被兩個程式插隊，結果就是垃圾。

## 技術核心

### 根因一：共享儀器沒有互斥鎖，量到別台的畫面

情境模擬（依公開規格推演）：四工位治具、一支 CA-410 probe 輪流對位，四個 Python worker 同時跑。每個 worker 都直接對 CA-410 的 COM port 下命令，沒有任何協調。CA-410 的命令流是「進 remote mode → 量測 → 取值 → 退 remote mode」的完整序列，兩個 worker 的序列交錯之後，probe 量到的可能是隔壁工位的測試圖案，重測率直接翻倍。

修正的結構很簡單：把儀器包成一個類別，量測函式內部用鎖保護，量測段成為唯一的 critical section（關鍵區段）：

```python
import threading, serial  # pyserial 已查證（官方 API 文件）

class CA410:
    def __init__(self, port: str):
        # exclusive=True（POSIX）：防止第二個 process 開同一 port（pyserial 已查證）
        self.ser = serial.Serial(port, exclusive=True, timeout=2.0)
        self.lock = threading.Lock()

    def measure_xy(self, probe_ch: int) -> tuple:
        with self.lock:                    # 量測段 = 唯一 critical section
            self._cmd("COM,1")             # Remote ON（已查證：COM,[1]，通訊規格 p.24）
            self._cmd(f"MEASURE,{probe_ch}")  # 示意命令，非實際規格（待查證）
            resp = self._cmd("GET,XY")        # 示意命令，非實際規格（待查證）
            self._cmd("COM,0")             # Remote OFF（已查證：COM,[1] 0/1）
            x, y = resp.split(",")            # 示意解析
            return float(x), float(y)
```

鎖的粒度是整個「進 remote → 量測 → 取值 → 退 remote」序列，不是單一命令。鎖單一命令等於沒鎖。

### 根因二：用 --display 綁定 DUT，綁到一個會漂的編號

ddcutil 的 display number 是偵測時依 I2C bus 順序分配、從 1 開始的邏輯編號（來源：ddcutil 官方文件 Display Selection 頁）。四台 DUT 上電與 HPD 出現順序每次不同，`--display 2` 今天綁工位 2、明天可能綁工位 3。更陰險的是 DP 來源的螢幕可能同時出現在兩個 bus 上（phantom display，ddcutil FAQ 已說明），偵測結果本身就不可靠。

正確做法是用實體不變量綁定：

- `--bus <n>`：治具走線決定 i2c bus number，焊死在治具上不會漂；ddcutil 官方 FAQ 也說明 `--bus` 可以跳過偵測階段，省時間。
- `--sn <serial>`：EDID 的 ASCII serial number，每台唯一（來源：ddcutil Display Selection 頁）。

```python
# DUT 綁定：實體不變量，不用 --display
subprocess.run(["ddcutil", "--bus", str(bus), "--sn", sn] + opts + args, ...)
```

### 根因三：dynamic sleep 統計檔被並行污染

ddcutil 預設開啟 dynamic sleep，會自動增減等待倍率，而且調校資料跨程式執行保存在 `$HOME/.cache/ddcutil/stats`（來源：官方文件 Performance and Tuning Options 頁）。單機跑是聰明設計，四個 worker process 同時讀寫同一份統計檔就是災難：A 調好的倍率被 B 覆蓋，DDC/CI 失敗率上升觸發 retry，retry 又寫統計檔，惡性循環。

並行場景的標準配置：

```python
DDC_OPTS = ["--disable-dynamic-sleep",      # 關閉跨 process 共享的 stats
            "--sleep-multiplier", "0.5",    # 固定倍率，需在該機種實測標定
            "--noverify"]                   # 校正站迭代用；複測站建議保留 verify
```

官方文件提到部分螢幕在 sleep-multiplier 低至 0.1 仍正常，但調低會增加通訊失敗與 retry，建議用 `--stats tries` 實測挑最佳值（同上來源）。retry 預設上限是 write-only 4 次、write-read 10 次、multi-part 8 次（同上來源），排程預算要把 retry 時間算進去。

### 根因四：排程沒做 pipeline，UPH 只漲不跌的數學

校正一個循環的時間組成：

```
切 pattern（DDC/CI 寫入）→ settle → CA-410 量測 → 計算 gain → 寫回 → settle → 複測
```

單 DUT 時這些段串聯；並行時只有「量測」被儀器序列化，其他段各自獨立。並行站的 takt 公式：

```
takt = max( 量測段時間 , (非量測段時間總和) / 並行度 )
```

情境模擬（依公開規格推演）：單 DUT takt 90 秒中，若量測段只佔 15 秒、非量測段 75 秒，四工位並行後 takt = max(15, 75/4) = 18.75 秒，UPH 約 192；但如果排程寫成「每個 worker 抓著儀器不放直到整個循環做完」，takt 變成 90 秒 ÷ 4 工位輪流 ≈ 22.5 秒起跳，再算上搶鎖失敗與重測，UPH 只能從 40 爬到 48。（takt/UPH 數字皆為情境模擬推演值。）

要再往上拉的三條路：

1. **多支 probe**：CA-410 官方 datasheet 標明「Multi probe connection 10 probes (maximum)」，一支 data processor 可接多支 probe；multi-probe 是否可真正同時量測，需對照通訊規格（待查證）。
2. **縮短量測段**：灰階數、積分時間、低灰階的量測時間（低灰階量測較慢，見前篇 CA-410 文章）。
3. **壓縮非量測段**：韌體端提供 commit-done 旗標，讓腳本輪詢「真的生效了」取代盲等最壞情況的 settle。

### 根因五：韌體端配合——Factory Mode 的可預測回應

排程優化做到極致後，非量測段的最大殘留是 settle：DDC/CI 的 ack 只代表匯流排層收到，不代表影像 pipeline 已生效（前篇閉式解文章已詳述）。韌體端可以提供兩個幫助：

```c
/* factory_mode_ddc.c — 暫存器地址皆為示意地址，非實際晶片規格；
 * DDC/CI slave address 0x37 為 MCCS 公開定義（已查證）。 */
#define DDC_CI_SLAVE_ADDR    0x37   /* 已查證：DDC/CI 位址（MCCS 公開定義） */
#define REG_DDC_CTRL         0x1F02 /* 示意地址，非實際晶片規格 */
#define REG_DDC_READY_FLAG   0x1F03 /* 示意地址，非實際晶片規格 */
#define BIT_DDC_FACTORY_FAST 0x04   /* 示意位元，非實際晶片規格 */

void factory_mode_enter(void)
{
    /* 示意：Factory Mode 走 fast path，跳過 OSD 儲存與 gamma 重載完整流程 */
    Scaler_Write_Register_Byte(REG_DDC_CTRL, BIT_DDC_FACTORY_FAST); /* 示意 Macro，非實際晶片規格 */
}

void ddc_commit_done_notify(void)
{
    /* 示意：pipeline double-buffer 交換完成後置位；腳本輪詢此旗標取代盲等 */
    Scaler_Write_Register_Byte(REG_DDC_READY_FLAG, 0x01); /* 示意地址，非實際晶片規格 */
}
```

腳本透過 DDC/CI 讀廠商專屬 VCP 代碼（示意，非 MCCS 公開定義）輪詢 ready 旗標，settle 段從「最壞情況」壓到「實際情況」。這是系統廠韌體與產線腳本一起優化 takt 的標準分工。

## 真實血淚案例

情境模擬（依公開規格推演），非真實客戶或產品事件。

某機種量產爬坡，產能會議上主管拍板：「校正站改成四台並行，UPH 翻四倍，下週導入。」治具商把四工位盤子做好了，軟體廠商把原本單台的校正腳本複製四份、開四個 process 就交貨。

導入第一週：重測率從約 5% 竄到 20%，複驗站大排長龍；更慘的是品保抽檢發現有機器的 RGB gain 根本不是自己工位算出來的值——A 工位寫的 gain 出現在 B 工位的機器上。產線停線檢討，8D 會議上把三個症狀擺在一起看：

- 量到亂數 → 四個 process 搶同一台 CA-410，命令流交錯；
- gain 串台 → `--display` 綁定隨偵測順序漂移；
- UPH 只從 40 升到 48 → 沒做 pipeline，四個 worker 排隊搶儀器。

三個症狀共用一個根：**把共享資源當私有資源用**。修正後（儀器鎖＋實體位址綁定＋pipeline 排程＋關 dynamic sleep），重測率回到個位數，UPH 才真正按 takt 公式爬上去。這個案例的教訓不是「並行化很難」，而是「並行化之前先畫資源表：哪些段是烤箱、哪些段是揉麵團」。

## 新人避坑指南

1. **共享儀器必須有鎖，而且鎖整段序列**：CA-410 的「進 remote → 量測 → 取值 → 退 remote」是一個不可分割的序列。跨 process 再加一層 pyserial `exclusive=True`（POSIX，已查證），防止第二個 process 重複開 port。
2. **DUT 綁定用實體不變量**：`--bus`（治具走線）＋`--sn`（EDID ASCII serial）。`--display` 是偵測順序的產物，會漂；DP 來源還有 phantom display 問題。
3. **並行 process 關掉 ddcutil dynamic sleep**：統計檔是跨 process 共享的，並行必污染。改固定 `--sleep-multiplier`，並在該機種實測標定。
4. **UPH 用瓶頸公式算，不要用除法**：takt = max(量測段, 非量測段/並行度)。量測段被儀器序列化，是硬瓶頸；要拉 UPH 先問「量測段能不能變短或變多支 probe」。
5. **retry 與 capabilities 是隱形成本**：ddcutil 預設 retry 上限 write-only 4／write-read 10／multi-part 8 次，capabilities 是最貴的命令且可快取（皆出自官方文件）；並行站錯誤率上升時，retry 會吃掉排程餘裕。
6. **結果要能回答「哪個工位、哪支 probe 量的」**：量測紀錄綁 DUT 序號、i2c bus、probe 通道、儀器序號（traceability 細節見前篇 MES 文章）。並行站出問題時，這是唯一能快速定位的線索。
7. **韌體端別缺席**：settle 的最壞情況是腳本盲等的來源；Factory Mode 的 fast path 與 commit-done 旗標（示意實作見上）是系統廠能提供的最大 takt 禮物。

## 思考題

CA-410 官方 datasheet 標明一支 data processor 最多可接 10 支 probe。假設量測段仍是整站瓶頸，你會如何用通訊規格驗證「10 支 probe 是否可以同時量測」？請設計一個最小實驗（量什麼、怎麼判斷），並說明若答案是「仍需輪詢」，takt 公式要怎麼改。

<details>
<summary>提示（點擊展開）</summary>
下載 Konica Minolta 官網的 CA-410 Communication Specifications（需同意使用條款），查 multi-probe 相關命令的語意：命令是「選一支 probe 量」還是「廣播全體量」。最小實驗：兩支 probe 分別對兩台同步顯示同一 pattern 的 DUT，同時下量測命令，觀察是否各自回傳獨立結果、有無命令衝突錯誤碼。若需輪詢，量測段時間 = 單次量測時間 × probe 數，takt 公式的量測段要乘上係數。
</details>

## 參考資料

1. ddcutil Display Selection（官方文件）：https://www.ddcutil.com/display_selection/ — display number 依 I2C bus 順序分配、--bus/--sn/--mfg/--model 綁定選項
2. ddcutil Performance and Tuning Options（官方文件）：https://www.ddcutil.com/performance_options/ — DDC/CI 40–200 ms 等待、約 90% 時間在等待、--sleep-multiplier（部分螢幕可低至 0.1）、--enable/disable-dynamic-sleep 與 $HOME/.cache/ddcutil/stats、--maxtries 預設 4/10/8、capabilities 最貴且可快取
3. ddcutil FAQ（官方文件）：https://www.ddcutil.com/faq/ — --bus 跳過偵測階段、DP phantom display、USB MCCS 通訊不需等待
4. Konica Minolta CA-410 Communication Specifications Ver 1.08（官方 PDF，KMSE AA1J-CS.08E，117 頁）：https://www.konicaminolta.com.cn/instruments/download/software/driver/ca-410a_cs0108e_eng.pdf — COM 命令（Remote ON/OFF，PDF p.24）、命令記法（PDF p.23）；最新版 Ver 1.13 於官方下載頁 https://www.konicaminolta.com/instruments/download/software/display/index.html （需同意使用條款）
5. Konica Minolta CA-410 datasheet（官方）：https://www.atecorp.com/getmedia/53be10c0-1cae-47d1-b2ed-c67b1a28e9d1/konica-minolta-ca-410-datasheet-1.pdf — Multi probe connection 10 probes (maximum)、user calibration memory 99 channels、USB 2.0／RS-232C
6. pyserial API 文件（官方）：https://pyserial.readthedocs.io/en/latest/pyserial_api.html — Serial 的 exclusive 參數（POSIX 專屬）、timeout 語意
