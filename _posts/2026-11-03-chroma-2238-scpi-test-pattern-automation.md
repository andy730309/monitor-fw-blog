---
layout: post
title: "訊號產生器回了 OK，量到的卻是上一張圖？Chroma 2238 遠端控制與 test pattern 自動化的四個坑"
date: 2026-11-03
tags: [Chroma 2238, pattern generator, SCPI, RS-232, DDC/CI, CA-410, test automation, settle time]
level: intermediate
prerequisites: ["DDC/CI 與 MCCS 入門：用 ddcutil 從電腦控制顯示器（posts/2026-10-28-ddc-ci-mccs-ddcutil-intro.md）", "校正站重測率飆到 18%？CA-410 與 ArgyllCMS 量測自動化的四個時序與授權坑（posts/2026-11-01-ca410-argyllcms-measurement-automation.md）"]
series: "從零成為顯示器架構師"
topic_track: C
roadmap_stage: practitioner
sources_checked: 2026-11-03
difficulty: intermediate
---
自動化測試台最貴的錯誤，不是儀器壞掉，而是「程式以為成功」。訊號產生器收到一行命令、回了 OK、腳本繼續跑，量測結果也存進資料庫；三天後看趨勢圖才發現，某一批 sample 量的其實是上一張測試圖。這篇從 Chroma 2238 的公開手冊出發，拆解遠端控制與 test pattern 自動化最容易踩的四個時序坑，並給一套不靠 magic sleep 的寫法。

## 前置知識

先想像你在一間廣播電台工作。你對著麥克風說「播下一首歌」，控制室回你「好，已經播了」。但這句「好」只代表控制室按下了播放鍵，不代表聽眾的收音機已經收到、而且聲音穩定。你要怎麼知道聽眾真的聽到新歌？只能在收音機端聽：聽到新歌、而且連續聽幾秒都穩定，才算數。

儀器控制也有這兩種模型。SCPI（Standard Commands for Programmable Instruments，可程式儀器的標準命令集）像一間有回報制度的電台：除了設定命令，還有查詢命令與狀態回報，你可以問「做完了沒」。SCPI-99 由 IVI Foundation 維護，是儀器界共同的語言。

Chroma 2238 的公開手冊走的是另一條路。它列出的遠端命令是自家 ASCII 字串，例如 `RUN TIM 0601 ;`、`RUN PTN 0105 ;`，結尾用分號。手冊 §3.2（PDF p.65）寫明：儀器收到命令會先檢查參數，執行正常回 `OK;`，否則回 `NG;` 加錯誤說明（例如 `NG; BOUNDARY ERROR:`）。但手冊沒有列出 `*IDN?`、`*OPC?`、錯誤佇列這類 SCPI 查詢命令。也就是說：**這台會回「控制室已執行」，但不會告訴你「DUT 畫面已經穩定」。**

另一個要先分清楚的名詞是 timing 與 pattern。timing 是解析度、更新率、前後 porch 那組時序參數；pattern 是畫面內容，例如白窗、灰階、彩條。2238 的兩條命令都寫成「先載入、再啟用」（手冊 §3.2.2，PDF p.66）；實務上先送 timing、再送 pattern。順序反過來，或只做一半，畫面就不是你要的那張。

## 技術核心

### 手冊到底寫了什麼

Chroma 2238 使用者手冊的 Communication 章節很短，公開的 general command 只有以下兩條（§3.2.2，PDF p.66；該頁註明「*RS232 commands are building」，表示命令表還在補，完整命令集待查證）：

```text
RUN TIM xxxx ;   先載入 timing xxxx 並啟用。
RUN PTN xxxx ;   先載入 pattern xxxx 並啟用。
```

序列埠設定也寫死了：USB 轉 RS-232 轉接器插上 USB Host 埠時，系統自動把通訊格式設為 115200、8-N-1（手冊 §3.1，PDF p.65）。命令送出後，儀器會回 `OK;` 或 `NG;`（§3.2，PDF p.65）。要分清三件事：位元離開本機 UART，不代表儀器收到；收到 `OK;`，代表儀器已執行換圖命令；但兩者都不代表 DUT 已經穩定顯示新圖。

這裡有兩個常見誤會。第一，口語常把「用程式控制儀器」統稱 SCPI，但口語不是規格；寫測試程式時，第一個動作應該是翻手冊確認命令集，而不是預設 `*OPC?` 一定存在。第二，以為儀器不回話就只寫 write，結果把手冊明寫的 `NG;` 錯誤回應整個丟掉。

### 0.2 秒不是「可以量了」的時間

Chroma 官網標示 2238 的 8K 畫面切換只需 0.2 秒。這個數字很容易被誤用成 settle time，但它描述的是 VPG 內部圖形核心換圖的速度。

從命令送出到量測儀器可以讀值，中間至少還有三段：

1. timing 變更造成 link retrain，DP 或 HDMI 重新協商。
2. DUT scaler 重新鎖定，套用 picture mode、HDR tone mapping、local dimming。
3. panel 與背光穩定，包含 ABL、PWM duty 與 overdrive 收斂。

0.2 秒只涵蓋這三段之前 VPG 自己換圖的時間，三段都不在裡面。這就是為什麼「固定 sleep 300 毫秒」在某些組合看起來夠、在 4K120 加 HDR 加分區控光時就不夠。更麻煩的是它不一定每次都錯，而是偶發，讓人誤以為是儀器不穩。

### DDC/CI 的 ack 只到匯流排層

測試腳本通常會用 DDC/CI 讀 DUT 的亮度或輸入源，當作「DUT 還活著」的依據。但 ddcutil 官方文件在 `setvcp` 一節寫得很清楚：它收到的是 I2C 層「request packet received」的 ack，沒有「display 已成功執行」的 ack；預設的 verify 是再跑一次 `getvcp` 確認。

所以：

- `setvcp` 沒報錯，只代表命令送到。
- `getvcp` timeout，也不代表 DUT 壞了，可能只是 timing 切換還在 retrain。

把 DDC/CI 當成同步 RPC，就會在錯誤的時間窗讀值，然後把協定時序問題誤判成硬體問題。

### 三個 gate：把「就緒」變成可觀測條件

比較穩的流程不是找一個更大的 sleep，而是把就緒拆成三個可觀測的 gate：

```text
送出 RUN TIM
   │
   ├─ Gate 1：DDC/CI 心跳成功（DUT 可服務）
   │
送出 RUN PTN
   │
   ├─ Gate 2：DDC/CI 心跳仍成功（保守確認）
   │
   └─ Gate 3：量測值連續收斂（畫面真的穩了）
          │
          └─ 寫入結果（帶 timing/pattern/module/serial/fw hash）
```

Gate 1 與 Gate 2 擋掉 link retrain 期間的假 timeout。Gate 3 才是真正的畫面穩定判據：用 CA-410 對同一個 patch 連續量測，直到相鄰樣本差異落在門檻內、連續數次成立。門檻不能憑感覺，至少要大於儀器本身的雜訊與精度。

如果 DUT 是自己的韌體，還有更乾淨的做法：提供 vendor VCP 的 pipeline status，timing 鎖定且 picture mode 套用完成才回新序號。測試端驗「序號有變」，而不是驗「setvcp 沒報錯」。

### 程式碼：傳輸層要誠實

```python
# chroma2238.py — 傳輸層（架構示意）
# 已查證：命令語法、OK/NG 回應與序列埠參數出自 2238 User's Manual
#         §3.1、§3.2（PDF p.65）、§3.2.2（PDF p.66）。
# 重要：公開命令集不是 SCPI，沒有 *IDN? / *OPC? / SYST:ERR?；
#       OK 只代表儀器已執行命令，不代表 DUT 已穩定。
#       回應的實際位元組（是否帶 CR/LF）待實機確認。

import serial

class Chroma2238:
    def __init__(self, port: str):
        self.ser = serial.Serial(
            port=port,
            baudrate=115200,
            bytesize=serial.EIGHTBITS,
            parity=serial.PARITY_NONE,
            stopbits=serial.STOPBITS_ONE,
            timeout=2.0,                # 等 OK/NG 的上限，示意值，依實測調整
            write_timeout=1.0,
        )

    def _send(self, cmd: str) -> None:
        if not cmd.endswith(";"):
            cmd += ";"                  # 手冊命令以分號結尾，不可用 \n 代替
        self.ser.reset_input_buffer()   # 丟掉上一筆殘留回應，避免對錯回應
        self.ser.write(cmd.encode("ascii"))
        self.ser.flush()                # 只保證離開本機 buffer
        resp = self.ser.read_until(b";").decode("ascii", "replace").strip()
        if not resp.endswith(";"):
            raise TimeoutError(f"{cmd!r}: 沒收到 OK/NG，收到 {resp!r}")
        if resp.upper().startswith("NG"):
            detail = self.ser.read(64).decode("ascii", "replace").strip()
            raise RuntimeError(f"{cmd!r}: {resp} {detail}")
        if not resp.upper().startswith("OK"):
            raise RuntimeError(f"{cmd!r}: 非預期回應 {resp!r}")

    def run_timing(self, timing_id: int) -> None:
        self._send(f"RUN TIM {timing_id:04d}")

    def run_pattern(self, pattern_id: int) -> None:
        self._send(f"RUN PTN {pattern_id:04d}")
```

這段程式每送一條命令就等 `OK;`：收到 `NG;` 或逾時就丟例外，不讓腳本帶著錯誤繼續量。但它刻意不把 `OK;` 當成「可以量了」，後面的 gate 才負責判斷 DUT 是否穩定。

再來是量測收斂。以下門檻與間隔是起點，實際要依儀器精度與 panel 雜訊調：

```python
# stable_measure.py — 以量測值收斂當作穩定判據（示意）
import time

def wait_ddci_ready(ddci, timeout_s=5.0):
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        try:
            ddci.getvcp(0x10)           # 亮度，MCCS 公開 VCP code
            return
        except Exception:
            time.sleep(0.05)            # 退讓重試，間隔為個人經驗推論
    raise TimeoutError("DDC/CI not ready")

def wait_until_stable(measure_fn, rel_tol=0.01, n_consecutive=3,
                      timeout_s=10.0, min_interval_s=0.15, abs_floor=0.05):
    t0 = time.monotonic()
    prev, streak, samples = None, 0, []
    while time.monotonic() - t0 < timeout_s:
        s = measure_fn()
        samples.append(s)
        if prev is not None:
            # 低亮度 patch 用絕對門檻下限，避免 Y 接近 0 時永遠不收斂（abs_floor 示意值）
            tol = max(rel_tol * prev["Y"], abs_floor)
            if abs(s["Y"] - prev["Y"]) <= tol:
                streak += 1
            else:
                streak = 0
        prev = s
        if streak >= n_consecutive:
            return s, {"settle_s": time.monotonic() - t0, "samples": len(samples)}
        time.sleep(min_interval_s)
    raise TimeoutError(f"not stable, last={samples[-1] if samples else None}")
```

最後是 DUT 端。若 DUT 是自家韌體，讓 DDC/CI 回報「已套用」比讓測試端猜更省事：

```c
/* vcp_status.c — 把 pipeline 套用完成做成可讀狀態（示意架構） */
/* 以下暫存器地址與 Macro 均為示意地址，非實際晶片規格 */

#define SYS_PIPELINE_STATUS   0x0000  /* 示意地址，非實際晶片規格 */
#define SYS_COMMIT_SEQ        0x0004  /* 示意地址，非實際晶片規格 */
#define Scaler_Read_Register_Byte(addr)  read_reg8(addr)  /* 示意 Macro */

/* vendor VCP code；0xE1 僅為示意，非 MCCS 公開定義 */
#define VCP_VENDOR_PIPELINE_STATUS  0xE1

unsigned char Vcp_Get_PipelineStatus(void)
{
    unsigned char st = Scaler_Read_Register_Byte(SYS_PIPELINE_STATUS);

    if ((st & 0x03u) == 0x03u) {          /* timing locked + pipeline applied */
        /* 韌體遞增序號時要跳過 0，否則測試端分不出「未生效」和「序號剛好是 0」 */
        return Scaler_Read_Register_Byte(SYS_COMMIT_SEQ);
    }
    return 0u;                             /* 尚未生效，測試端不可量測 */
}
```

### 多模組：身分不能靠「我以為」

2238 最多可以同時插四張 signal module，同時輸出四種解析度與 pattern（Chroma 官網）。好處是產線可以並行測多台 DUT，壞處是命令的作用對象變得重要。

手冊在 EDID、DDC/CI 等功能頁有 PORT NO. 的選擇（HDMI Port 1～4、DP Port 1～2、ANALOG Port 1），但公開的 general command 只有 `RUN TIM` 與 `RUN PTN`，沒有公開的 port 參數語法。多模組並行時，命令實際落到哪張模組、哪個輸出埠，必須靠 VPG Master 或 SDK 的對應設定，或 SMART I/O 的硬體觸發來界定。這段的實際語法**待查證**，不要用猜的寫進產線程式。

實務上的折衷：bench 設定檔明列 module 與 DUT 的對應，程式不自己推斷；每一筆結果都帶 `module.id`、`vpg.serial`、`dut.serial`、`fw_hash`、`timing_id`、`pattern_id`、`settle_s`。出問題時才有辦法歸因。

## 真實血淚案例

情境模擬（依公開規格推演），非真實客戶或產品事件。

某台 4K 120Hz 機種在 DVT 階段，nightly 影像品質測試約有 8% 的結果對不上圖案：報表寫白窗，實際光譜是黑底白十字。症狀集中在 4K120、HDR 開關與 local dimming 切換之後，重跑同一 test case 不一定重現。

產線端同時出現另一個症狀：校正站切完 pattern，第一次 DDC/CI 讀值偶發 timeout，重試兩次就過；過了之後量到的亮度偏低 3～5%，複驗才正常。OP 換了兩批 panel，症狀一樣。

RD 一開始懷疑 2238 不穩，但同一台儀器用手動面板操作完全正常。追下去發現三件事：

1. 測試框架把 2238 當成 SCPI 儀器，沒讀 `OK;`／`NG;`，送完 `RUN PTN` 就固定等 300 毫秒（示意設定值）。0.2 秒是 VPG 換圖時間，不是 DUT 穩定時間；4K120 加 HDR 加分區控光，300 毫秒不夠。
2. 換 timing 後，程式立刻用 DDC/CI 讀值。那段時間 link 正在 retrain，timeout 是正常的；包裝層重試後通道恢復，但量到的是還沒穩定的過渡幀。
3. 四張 module 並行時，程式沒有紀錄命令對應哪張卡。異常發生時，報表的 pattern id 與實際畫面無法對照。

修正分成四步：

1. 傳輸層每條命令都等 `OK;`，收到 `NG;` 或逾時就中止；序列埠固定 115200、8-N-1，命令補分號；用 `/dev/serial/by-id` 綁定轉接器。
2. timing 切換後先做 DDC/CI 心跳，失敗走退讓重試，不在 retrain 期間硬讀。
3. pattern 量測改成連續樣本收斂判據，settle 時間依實際狀態浮動。
4. 每個結果綁 VPG 序號、module id、DUT 序號、FW hash、timing/pattern id 與 settle 統計。

模擬推演結果是：對不上圖案的比例回到可接受範圍，校正站的假 timeout 不再被當成硬體異常，異常樣本也追得回是哪張 module、哪個 timing。這些是流程修正的方向，不是公開量測資料；實際門檻仍要用現場儀器與 panel 標定。

## 新人避坑指南

- **先翻手冊確認命令集**：不是每台儀器都吃 SCPI。2238 公開手冊只列 `RUN TIM` 與 `RUN PTN`，每條命令回 `OK;` 或 `NG;`，但沒有 `*OPC?` 這類查詢。
- **`write()` 成功不等於儀器收到**：pyserial 回傳的是寫進 OS buffer 的位元組數；baud 設錯、結尾字元錯，都不會拋例外。要讀回 `OK;` 才算儀器收到並執行。
- **`OK;` 不等於可以量**：它只代表儀器執行了命令，DUT 端的 retrain 與穩定要另外判斷。
- **0.2 秒不是 settle time**：那是 VPG 換圖時間；DUT 的 link retrain、scaler 套用、panel 穩定都要另外算。
- **DDC/CI 的 ack 只到匯流排層**：`setvcp` 沒報錯不代表畫面已套用；`getvcp` timeout 也不代表 DUT 壞掉。
- **不要用更大的 sleep 解時序問題**：sleep 只會讓測試變慢，不會讓它變準。用可觀測的 gate。
- **量測收斂門檻要大於儀器雜訊**：門檻訂得比儀器精度還小，永遠不會收斂，只會逾時。只看 Y 也分不出亮度相近的兩張圖，必要時一併比對 xy 或預期範圍。
- **多模組要把身分寫進設定檔**：命令作用對象、結果歸屬都要能追溯，不要靠「我以為是 M1」。
- **順序是 timing 再 pattern**：手冊明寫「先載入並啟用」，兩條命令是兩個動作。
- **異常要留原始樣本序列**：只存平均值，事後分不出「沒穩定」與「真的偏」。

## 思考題

假設 2238 的 8K pattern 切換時間是 0.2 秒，而你的 DUT 在切換後 150 毫秒就量到穩定亮度。請問這樣是否代表可以把 settle 固定設 150 毫秒？

<details>
<summary>看提示</summary>

不行。0.2 秒是 VPG 內部換圖時間，不是命令送到 DUT 完成顯示的時間；150 毫秒量到穩定，也只代表那次量測時 DUT 剛好已經穩定，還可能有 link retrain、HDR 模式切換、local dimming 等情況讓穩定時間變長。settle 應該是「偵測到穩定才繼續」的動態條件，而不是一個固定的最小等待。固定值只能當下限，不能當保證。

</details>

## 參考資料

1. Chroma ATE，Model 2238 Video Pattern Generator 產品頁（7 吋 1024×600、最多 4 張 signal module、2000 timing / 5000 pattern、8K 換圖 0.2 秒、Gigabit Ethernet、VPG Master 與 SDK、SMART I/O GPIO/+5V）：https://www.chromaate.com/en/product/video_pattern_generator_2238_287 （官方）
2. Chroma ATE，Video Pattern Generator 2238 Datasheet：https://www.chromaate.com/downloads/catalogue/Video/2238-EN.pdf （官方）
3. Chroma ATE，Video Pattern Generator 2238 User's Manual（§3.1 RS-232 115200 8-N-1，PDF p.65；§3.2 命令格式與 OK/NG 回應，PDF p.65；§3.2.2 General Commands `RUN TIM`/`RUN PTN`，PDF p.66；PDF 由代理商網站公開）：https://www.acquisys.fr/wp-content/uploads/2018/06/en_2238_usermanual_1709rv.pdf （官方文件，非官方鏡像）
4. ddcutil，setvcp（I2C ack 不等於執行成功、預設 getvcp verify、--noverify）：https://www.ddcutil.com/command_setvcp/ （官方）
5. ddcutil，Command Overview（detect/getvcp/setvcp/scs、--bus/--display）：https://www.ddcutil.com/commands/ （官方）
6. IVI Foundation，Specification Downloads（SCPI-99 由 IVI Foundation 維護）：https://ivifoundation.org/specifications/default.html （官方）
