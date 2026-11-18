---
layout: post
title: "訊號產生器半夜抽風？Quantum Data 882E Telnet 遠端控制的三個坑：IAC 髒字元、沒握手就連發、USB 卡在 Disk 模式"
date: 2026-10-31
tags: [Quantum Data, 訊號產生器, Telnet, pyserial, 自動化測試, HIL, DDC/CI]
level: intermediate
prerequisites: ["DDC/CI 與 MCCS 入門：用 ddcutil 從電腦控制顯示器", "Nightly DP 測試一直 flaky？UniTAP 自動化台的三個前置與追溯坑"]
series: "從零成為顯示器架構師"
topic_track: C
roadmap_stage: practitioner
sources_checked: 2026-10-31
difficulty: intermediate
---
# BLOG 標題：訊號產生器半夜抽風？Quantum Data 882E Telnet 遠端控制的三個坑：IAC 髒字元、沒握手就連發、USB 卡在 Disk 模式

## 【前置知識準備】

先把三個名詞講白。

**訊號產生器（video signal generator）**：你可以把它想成「會說 HDMI 方言的假電腦」。顯示器（DUT）要測各種解析度，總不能每次都找一台真的 PC 去改設定；訊號產生器就是一台專門產生標準測試訊號的儀器，你要 4K60 就給 4K60，要 1080p 就給 1080p。Quantum Data 的 882E 是這一行的老面孔，公開 datasheet 載明它的控制介面有三種：RS-232 serial、Ethernet（TCP/IP、FTP、Telnet）、GPIB。

**Telnet**：老式遠端登入協定，走 TCP，但跟「裸 TCP」不一樣。它有自己的一套帶內控制語言：任何以 IAC（Interpret As Command，位元組 0xFF）開頭的序列都是控制命令，不是資料。這是 RFC 854 定義的。類比一下：你對講機講話前要先按住通話鍵，IAC 就是那個通話鍵訊號；你把「按住通話鍵」的訊號也當成對白念出來，對方就會聽到一堆怪聲。

**命令列握手**：儀器的 CLI 是一個序列處理的小狀態機，你送一條命令，它處理完會回 echo 或 prompt（提示符）。就像你跟同事用無線電回報：「做完回我一句 OK」。你不等 OK 就連續下十道命令，中間那幾道就會在對方忙著做事時掉進水裡。

另外一個背景知識：Python 3.13 已經把標準庫的 `telnetlib` 移除了（PEP 594「dead batteries」清理，官方 What's New 明載）。所以現在寫儀器控制，Telnet 要嘛用 raw socket 自己處理 IAC，要嘛改走 serial 用 pyserial。

## 【系統廠真實血淚案例】

情境模擬（依公開規格推演），非真實客戶或產品事件。

DVT 階段，某 HDMI 2.1 sink 機種的 nightly regression bench（情境模擬）：Quantum Data 882E 走 Telnet 控制，每晚掃 30 組 timing，每組換完 format 用 DDC/CI 讀 DUT 狀態判定 pass/fail。跑了三晚，失敗率約 5%（示意），症狀是 DUT 回報無訊號，或 DUT 讀到的 timing 跟腳本 log 記的不一致——log 說下了 4K60，DUT 實際收到 1080p。

最氣人的是：白天工程師用 PuTTY 手動開 Telnet session，逐行敲同樣的命令序列，全過。ME 說治具沒動，PE 說 DUT 沒問題，腳本是三年前 copy 來的沒人敢動，大家開始考慮把 retry 加大矇混過關。

抓 Telnet session 的原始封包下來對時間軸，兩個根因：

**第一，IAC 髒字元污染命令流。** 882E 的 Telnet server 在連線建立時會送出選項協商序列（一串 0xFF 開頭的位元組）。腳本用 raw socket 直接把命令字串丟進去，第一條命令前面黏著這些位元組，CLI 解析成未知命令進 error state；腳本又從不讀回應，錯誤一路沉默到 DUT 無訊號。反方向也中：server 送回的資料混著 IAC 序列，腳本把整包 bytes 當 ASCII 去 match prompt，時中時不中。手動 PuTTY 全過的原因就在這——PuTTY 會處理協商，腳本不會。這是「手動會過、自動化會炸」的教科書案例。

**第二，命令無握手連發。** 腳本把 30 條 `FMTL`（load format，881/882 User Guide 命令列章節可見 `FMTL format` 用法）用迴圈一口氣 write 出去。882E 收到 format change 要重組 TMDS 輸出與 infoframe，CLI 序列處理，busy 期間進來的命令被丟棄或交錯。log 記錄「已下 4K60」，實際生效的是前一條或被吃掉的那條，DUT 讀到的 timing 自然對不上。手動測試時人會等 prompt，等效做了握手；腳本把這個握手吃掉了。

**附帶一坑，USB 卡在 Disk 模式。** bench 上另一台 780D 手持機用 USB 連 PC。780D 的 USB 有兩種模式：COM（命令模式）與 Disk（大量儲存，抓 bitmap、升級韌體用），要在機器 Preferences 裡手動切（780D User Guide §2.3；Portrait Displays 的 Calman 整合指南也明載 780 系列要先確認 USB Mode 選 COM）。上一位同仁用完留在 Disk 模式，隔天腳本 open COM port 直接失敗，nightly 整批 red，全組先懷疑腳本被改壞，浪費半天。

修正後的驅動層長這樣：

```python
# bench/qd_gen.py —— Quantum Data 882E 遠端控制驅動層
# 已查證：pyserial API（pyserial 官方文件）；IAC=0xFF 與跳脫規則（RFC 854）；
#        FMTL <format>（Quantum Data 881/882 User Guide 命令列章節）。
# 示意：prompt 字串與其他命令拼字依實機手冊確認，標「示意/待查證」。
import re
import socket
import time

IAC = 0xFF  # RFC 854: Interpret As Command

def strip_iac(data: bytes) -> bytes:
    """濾掉 Telnet IAC 序列（IAC IAC 代表資料 0xFF；IAC+cmd+option 整組丟棄）。"""
    out = bytearray()
    i = 0
    while i < len(data):
        b = data[i]
        if b != IAC:
            out.append(b); i += 1; continue
        if i + 1 < len(data) and data[i + 1] == IAC:
            out.append(IAC); i += 2
        elif i + 2 < len(data):
            i += 3
        else:
            i += 1
    return bytes(out)

class TelnetTransport:
    """raw socket + 最小 IAC 處理。Python 3.13 起無 telnetlib（PEP 594）。"""
    def __init__(self, host: str, port: int = 23, timeout: float = 3.0):
        self.sock = socket.create_connection((host, port), timeout=timeout)
        self.sock.settimeout(timeout)
        self.drain()  # 吃掉連線初期的協商序列

    def send(self, line: str):
        self.sock.sendall(line.encode("ascii") + b"\r")  # 終止字元依實機驗證（示意）

    def recv_some(self) -> bytes:
        try:
            return strip_iac(self.sock.recv(4096))
        except socket.timeout:
            return b""

    def drain(self):
        time.sleep(0.2)
        while self.recv_some():
            time.sleep(0.1)

    def close(self):
        self.sock.close()

class QuantumData882:
    """命令層：每條命令強制握手，讀到 prompt 才准下一條。"""
    PROMPT = re.compile(rb"[\r\n]>?\s*$")  # 示意 prompt 樣式，依實機修正

    def __init__(self, transport):
        self.t = transport
        self.log = []

    def cmd(self, line: str, settle_ms: int = 0) -> str:
        self.t.send(line)
        buf = b""
        deadline = time.time() + 5.0
        while time.time() < deadline:
            buf += self.t.recv_some()
            if self.PROMPT.search(buf):
                break
        else:
            raise TimeoutError(f"no prompt after: {line!r}, got: {buf[-200:]!r}")
        if settle_ms:
            time.sleep(settle_ms / 1000)  # format change 後等 TMDS 重鎖與 DUT 穩定
        self.log.append((time.time(), line, buf.decode("ascii", "replace")))
        return buf.decode("ascii", "replace")

    def load_format(self, fmt: str, settle_ms: int = 300):
        self.cmd(f"FMTL {fmt}", settle_ms=settle_ms)  # FMTL：已查證（881/882 User Guide）
        # 示意/待查證：回讀目前 format 驗證，命令拼字依實機手冊
```

serial 介面同一個命令層換 transport 即可（pyserial API 依官方文件，`exclusive=True` 防兩個腳本搶 port）：

```python
import serial

class SerialTransport:
    def __init__(self, port: str, baudrate: int = 115200, timeout: float = 3.0):
        self.ser = serial.Serial(port=port, baudrate=baudrate, bytesize=serial.EIGHTBITS,
                                 parity=serial.PARITY_NONE, stopbits=serial.STOPBITS_ONE,
                                 timeout=timeout, exclusive=True)
        self.ser.reset_input_buffer()

    def send(self, line: str):
        self.ser.write(line.encode("ascii") + b"\r")

    def recv_some(self) -> bytes:
        return self.ser.read_until(b"\n")  # pyserial 3.5+，含 terminator

    def drain(self):
        self.ser.reset_input_buffer()

    def close(self):
        self.ser.close()
```

## 【新人避坑指南（Mentor's Take）】

### 1. 看懂這個 Bug 的關鍵暫存器/訊號線是哪一個？

這題沒有 scaler 暫存器，關鍵在「連線層的位元組」：Telnet 的 IAC（0xFF）與命令終止字元。抓包看三個東西：連線建立後 server 送的前幾十個 bytes（協商序列）、你送出的命令前後有沒有黏髒字元、generator 的回應長什麼樣（echo？prompt？錯誤訊息？）。780 系列的話，關鍵不是訊號線而是機器面板上的 Preferences → USB Mode：COM 才是命令模式，Disk 是隨身碟模式，CLI 不通。

### 2. 未來寫 Code 或驗證時，如何避免重蹈覆轍？

- 儀器控制一律做 transport 抽象：連線後先 drain，所有讀取過 IAC 過濾，命令層強制 read-until-prompt 握手，禁止迴圈連發。
- 手動 PuTTY 驗證過不等於腳本會過：手動等效做了協商與握手，自動化要把這兩件事補回來。
- Python 3.11+ 不要 import telnetlib（3.11 棄用、3.13 移除，PEP 594）；用 raw socket + IAC 過濾或 pyserial。
- 780 系列 USB 開跑前確認 USB Mode = COM，把這條寫進 bench self-test 的錯誤訊息裡，別讓人先懷疑腳本。
- 每筆結果綁定 generator 型號/序號、transport、韌體版本、format 清單雜湊，fail 才追得回去。

### 3. 思考題

882E 的 datasheet 載明它還支援 GPIB（僅 882 系列）與 browser-based virtual control panel。假設你的 bench 要同時控兩台 generator（一台 Telnet、一台 RS-232），你會把「命令握手」放在 transport 層還是命令層？提示：想想 read-until-prompt 的 prompt 樣式在兩種 transport 上是否相同，以及 timeout 該由誰負責。去翻手上機器的 User Guide 命令列章節，確認 prompt 實際字串與命令終止字元（CR/LF/CRLF）再回答。

## 參考資料

- Quantum Data 780D User Guide（PDF 鏡像，非官方入口）：https://files.avprosupply.com/files/attachments/15798/quantum-data-video-test-signal-generator-780d-manual.pdf （第 13 章 Command Interface、§2.3 Administrative Interface：USB COM/Disk 兩模式）
- Quantum Data 881/882 User Manual（manualsdir 線上版，非官方）：https://www.manualsdir.com/manuals/207370/quantum-data-881-882.html （p.26 電腦介面：RS-232 null modem、Ethernet TCP/IP/FTP/Telnet、GPIB 僅 882；p.199 命令列範例 `FMTL format`）
- Quantum Data 882E datasheet（PDF 鏡像，非官方）：https://www.laatuantenni.fi/pictures/882e_ds.pdf （控制介面、browser-based virtual control panel、Script SDK）
- Portrait Displays：Quantum Data 780/880/980 Series Guide（Calman 整合，官方代理商文件）：https://www.portrait.com/resource-center/quantum-data-780-880-980-series-guide/ （780=USB serial、880=RS-232、980=Ethernet；USB Mode 須選 COM）
- pyserial 官方 API 文件：https://pyserial.readthedocs.io/en/latest/pyserial_api.html
- Python 3.13 What's New（telnetlib 移除，PEP 594，官方）：https://docs.python.org/3/whatsnew/3.13.html
- RFC 854 Telnet Protocol Specification（IETF 官方）：https://datatracker.ietf.org/doc/html/rfc854
