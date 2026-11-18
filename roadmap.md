---
layout: page
title: 學習路線
permalink: /roadmap/
---

> 給想進入系統廠 / ODM 顯示器韌體領域的新人。依學習路線由淺入深排列（Foundations → Practitioner → Senior → Principal）。
> 每篇文章由 Hermes 研究回合自動撰寫，皆附參考來源；標「（待查證）」處請以官方規格為準。

## Stage 1 — Foundations（基礎）
### 系列 A：顯示器是怎麼運作的
- [顯示器系統方塊圖入門：Scaler、T-CON、Panel、Backlight、PD、Hub 是怎麼分工的？]({{ site.baseurl }}{% post_url 2026-10-29-monitor-system-block-diagram %}) — beginner — 六大子系統分工、訊號/電源/控制三條路徑、USB-C PD 與 Alt Mode 架構
- [顯示器韌體工程師在系統廠/ODM 的角色與一天的工作]({{ site.baseurl }}{% post_url 2026-10-29-monitor-fw-engineer-role-odm %}) — beginner — 系統廠/ODM 韌體工程師職責全景、EVT→DVT→PVT→MP 四階段典型工作、與 IC 設計廠差異、常見陷阱與動手練習
- [色彩入門：RGB、Gamma、色溫、色域 (sRGB/DCI-P3/Adobe RGB)]({{ site.baseurl }}{% post_url 2026-10-29-color-basics-rgb-gamma-cct-gamut %}) — beginner — 四大色彩基石、sRGB 分段 EOTF vs 純 2.2、DCI-P3/Display P3/Adobe RGB 三大色域比較、CCT 與 xy 白點的關係、常見陷阱與動手練習
- [影像介面總覽：VGA / DVI / HDMI / DisplayPort / USB-C 的差異與演進]({{ site.baseurl }}{% post_url 2026-10-29-video-interface-overview %}) — beginner — 五大介面演進時間軸、TMDS/FRL/UHBR 編碼頻寬計算、USB-C Pin Assignment C/D/E、DP++ 與 Alt Mode 相容性陷阱、韌體三條路徑
- [OLED 螢幕燒屏怎麼防？顯示器韌體的 pixel shift、ABL 與 pixel refresh 三層防線]({{ site.baseurl }}{% post_url 2026-11-04-oled-burn-in-protection-pixel-shift-abl-pixel-refresh %}) — intermediate — OLED 自發光面板燒屏機制、pixel shift/orbit、ABL、pixel refresh/panel refresh FW 實作與客退根因
### 系列 B：嵌入式韌體基礎
- [DDC/CI 與 MCCS 入門：用 ddcutil 從電腦控制顯示器]({{ site.baseurl }}{% post_url 2026-10-28-ddc-ci-mccs-ddcutil-intro %}) — beginner — 學會用 ddcutil 讀寫亮度/色溫/輸入源，理解 EDID 0x50 與 DDC/CI 0x37
- [EDID 入門：用 edid-decode 解析顯示器身分證]({{ site.baseurl }}{% post_url 2026-10-29-edid-intro-edid-decode %}) — beginner — EDID Base Block 128 bytes 逐欄位拆解、DTD 18-byte 手算刷新率、CTA-861 Extension Block 與 HDR/VRR 宣告、edid-decode 實戰指令

## Stage 2 — Practitioner（獨立作業）
### 系列 C：影像介面入門（DP / HDMI / Type-C / VGA / EDID）
- [DPCD 入門：DisplayPort 設定資料結構與 Sink Capability 宣告]({{ site.baseurl }}{% post_url 2026-10-29-dpcd-sink-capability %}) — beginner — DPCD 位址空間架構、Receiver Capability 16 bytes 逐欄位解析、Extended Receiver Capability (HBR3/UHBR)、Link Config/Status 搭配 Link Training 流程、常見陷阱與 AUX analyzer 實戰練習
- [DSC 開下去畫面綠條亂竄？4K144 螢幕 sink 端 DSC 參數宣告與 PPS 驗證的坑]({{ site.baseurl }}{% post_url 2026-10-29-dsc-sink-params-slice-bpp-buffer-model %}) — intermediate — DPCD DSC capability（slice/throughput/max slice width）宣告收斂、PPS 128 bytes 與 chunk_size 的 Q4.4 分數 bpp 驗證、HRD buffer model 概念、多廠 GPU 驗證矩陣
- 4K120 悄悄掉回 4:2:0？HDMI 2.1 FRL 連結訓練與 SCDC 的 sink 端三個坑（即將推出） — intermediate — SCDC（I2C 0x54）暫存器地圖、FRL Rate 0x31 與 FLT_update 握手（sink 只 set 不 clear）、LTP 資料落位才通知、TMDS 1/10 vs 1/40 clock ratio、CED 錯誤計數追 RMA
- 主機開 VRR 螢幕在呼吸、game mode 回不去、QMS 照樣黑畫面？HDMI sink 端三個 metadata 解析的坑（即將推出） — intermediate — VRR/ALLM/QMS 三功能角色與 VTEM/HF-VSIF 載體、EDID HF-VSDB VRRmin/VRRmax 與 panel 實測能力收斂、vfront 變化與 format change 路徑分離、ALLM 明示退回＋watchdog 雙保險
- 4K144 只出 4K60、HDR 選項灰掉、改個 EDID 螢幕直接消失？CTA-861 extension 設計的三層坑（即將推出） — intermediate — EDID 1.3/1.4 介面分流、CTA-861 v3 結構層（H14b-VSDB 必配與 HF-VSDB 順序）、HF-VSDB 五條欄位交叉驗證、HDR SMDB TF/SM 位元與亮度公式、checksum/extension flag/HPD 單一 commit 出口
- DisplayID 2.x 與 EDID 並存：放錯 I2C 位址，8K 直接變 4K30（即將推出） — intermediate — DisplayID 2.x section 結構（0x20 header、use case、block tag）、E-DDC A0h/A4h 共存位址規則、1.3 Appendix B 舊路不背書、checksum 重算與 HPD 單一 commit 出口
- [螢幕充筆電十幾秒就斷？USB PD 3.2 EPR 的線材檢查、KeepAlive 與功率預算]({{ site.baseurl }}{% post_url 2026-11-03-usb-pd32-epr-avs-monitor-source-power-budget %}) — intermediate — EPR 進入流程（線材 50V/5A 檢查、Succeeded 時序）、KeepAlive 1 秒 fault 與排程位置、monitor 共享功率預算、AVS 100mV step 與 PPS 20mV step 的差別
- Type-C 一線通影像不進入 DP Alt Mode？VDM 流程、pin assignment 與 HPD/Attention 三個坑（即將推出） — intermediate — DP Alt Mode VDM 進入流程（Discover Identity/SVIDs/Modes → Enter Mode → DP Configure）、pin assignment C/D/E 與 AUX SBU 走線、HPD 透過 Attention VDM/DP Status 傳遞、sink 端 HPD 不持續根因與修正
- [USB-IF Type-C 與 PD 認證闖關指南：VDM 握手、EPR 狀態機與 Integrators List 實戰]({{ site.baseurl }}{% post_url 2026-11-03-usb-if-pd-typec-compliance-integrators-list %}) — intermediate — USB-IF compliance 測試架構、VDM Discover Identity 握手超時與 EPR KeepAlive 狀態機除錯、Integrators List 登錄流程與 pre-test 實務
- [DP AUX channel 時序錯誤與 EDID 解析錯位：從根因到韌體修正]({{ site.baseurl }}{% post_url 2026-11-16-dp-aux-edid-timing-error %}) — intermediate — DP AUX I2C-over-AUX 時序違規與 HPD toggle 缺失導致 EDID checksum 錯位，修正方案為 commit 出口處統一 toggle HPD 並驗證 reply code
- [碰一下線材就黑屏、睡醒就沒畫面？DisplayPort HPD 短脈衝與 debounce 的三個坑]({{ site.baseurl }}{% post_url 2026-11-17-hpd-short-pulse-debounce-state-machine %}) — intermediate — long/short pulse 語意分流、連續取樣 debounce、HPD assert 與 link/EDID/AUX 就緒順序、polling 備援
- [改了 EDID 螢幕卻沒變？checksum 錯位與 HPD toggle 的兩個 commit 陷阱]({{ site.baseurl }}{% post_url 2026-11-10-edid-checksum-hpd-toggle-reread %}) — intermediate — 動態 EDID 逐 block checksum 重算與 byte 126 extension flag 同步、kernel 對 Base Block checksum fail 丟整份 EDID 的行為、先落位再 toggle HPD 的單一 commit 出口、HPD 時序實測標定
- [訓練成功不是終點：HDMI FRL rate mismatch 與 SCDC 錯誤監控的三個坑]({{ site.baseurl }}{% post_url 2026-11-13-hdmi-frl-rate-mismatch-scdc-error-state-machine %}) — intermediate — SCDC 0x31 rate guard 交叉驗證 EDID Max_FRL_Rate、0x50–0x5A 錯誤計數 checksum 驗證與 LTP_REQ 降級請求、斷線即遺失的 SCDC 狀態生命週期重建
### 系列 D：色彩與畫質入門
- [白平衡校正把產線卡死？DDC/CI 等待、verify 與 store 的三個時間陷阱]({{ site.baseurl }}{% post_url 2026-10-30-factory-color-calibration-takt-time %}) — intermediate — 校正站 takt 瓶頸的三個根源（40–200 ms 協定等待、只有 I2C ack 沒有執行 ack、B0h store 才持久化）、批次 setvcp 與一輪閉式解、斷電重驗抓假過站
- [3D LUT 還是 3x3 矩陣？廣色域螢幕 sRGB 模式中間色爆掉的真正原因]({{ site.baseurl }}{% post_url 2026-10-30-3d-lut-vs-3x3-matrix %}) — intermediate — 矩陣是線性變換修不了 LCD 非線性 crosstalk、de-gamma→3D LUT→gamma 的 pipeline 順序、bit depth 預算、CRC 驗證失敗退回 matrix-only
- [SDR 校正 ΔE00 全綠，HDR 預測試卻 fail？ΔE2000 與 ΔITP 你不能混用的原因]({{ site.baseurl }}{% post_url 2026-10-31-deltae2000-vs-deltaitp %}) — intermediate — CIELAB 相對座標 vs PQ 絕對亮度、ΔITP 的 JND 縮放與 BT.2124 三步公式（0.5×CT、×720、BT.2020 矩陣）、HDR 低亮度 3D LUT 節點加密、Sharma test data 驗證法
- HDR 電影高光整片死白？PQ tone mapping 的 hard clip 陷阱與 MaxCLL/MaxFALL 正確用法（即將推出） — intermediate — PQ EOTF 常數逐位核對（m2 漏乘 128 地雷）、panel 能力內直通與 knee roll-off、CTA-861.3-A InfoFrame 0x07 的 MaxCLL/MaxFALL 解析與 unknown fallback、EDID ET_2/SM_0 宣告死法、DisplayHDR ΔITP 門檻
- 角落永遠比中間暗？Uniformity 補償表的線性域陷阱與亮度損失預算（即將推出） — intermediate — grid 量測與雙線性插值、gain 乘在 gamma 域造成 banding 的根因、以中心為參考的只壓不拉策略、DisplayHDR center patch 與 corner box 雙門檻的亮度損失預算、補償表 CRC 與 fallback、spotread -O/-N/-X 產線腳本
- 白點怎麼校都偏一邊？Colorimeter 沒做 CCMX/CCSS 光譜修正，校正站就是在用錯的尺（即將推出） — intermediate — colorimeter 濾片近似 vs 光譜儀數學積分的原理差異、3x3 矩陣的光譜假設被廣色域窄頻 primary 放大、CCMX（綁 colorimeter+display）與 CCSS（綁 display 光譜）的選用規則、韌體 Factory Mode panel 光譜查詢＋校正站自動選檔與殘差 fallback
- [暗場字幕一圈光暈？Mini-LED local dimming 的 duty 演算法與 halo/blooming 抑制]({{ site.baseurl }}{% post_url 2026-11-02-local-dimming-algorithm-halo-blooming-suppression %}) — intermediate — global/1D/1.5D/2D 調光架構與 zone 數、percentile 混合 max 的 zone 統計、BLU PSF 外擴核、線性域 LCD 反向補償、快攻慢收平滑與 duty/LCD gain 同 vblank 提交、分區數與面板對比的選型門檻
- [240Hz 調好的 Overdrive，開 VRR 到 70fps 卻一圈白光？可變 Overdrive 的 LUT 分層與插值]({{ site.baseurl }}{% post_url 2026-11-03-overdrive-table-variable-overdrive-vrr %}) — intermediate — OD LUT 的 A(B)=C 與時間維度、多 anchor LUT 與 Q8 插值、panel 實際影格週期 vs host FPS、死區/斜率限制與 vblank 切表、17×17 截斷表與 VA 暗階細表、VESA AdaptiveSync CTS 1.1 與 ClearMR 驗收語言
- [ClearMR 不是 FW 能刷出來的數字：VESA 動態模糊量測與 CMR 階級新人指南]({{ site.baseurl }}{% post_url 2026-11-03-vesa-clearmr-motion-blur-measurement %}) — intermediate — CMR 定義與階級區間（3000–21000）、CTS 測試條件上限（overshoot ≤20%、undershoot ≤1%）、FW 端 Overdrive 與背光 Duty 調校、認證前 pre-compliance 檢查清單
- [HDR10 預測試全綠，Dolby Vision 一開卻洗白？PC 螢幕韌體端的動態 metadata 與模式管理]({{ site.baseurl }}{% post_url 2026-11-04-dolby-vision-pc-monitor-overview %}) — intermediate — DV 與 HDR10 的動態/靜態 metadata 差異、L1 Min/Mid/Max 與 metadata level 表、profile 5/8.1/8.4/7 概況、VSIF 攔截＋模式狀態機（進入確認/watchdog/單一 commit）＋快攻慢收 knee 映射、SDK 認證與驗證矩陣
- [校正完隔天色彩又跑掉？ICC profile 與硬體校正的狀態一致性三個坑]({{ site.baseurl }}{% post_url 2026-11-04-icc-profile-hardware-calibration-integration %}) — intermediate — ICC.1:2022 檔案結構（128-byte header＋tag table）、profile 只對「同一顯示狀態」有效、vcgt 雙重校正陷阱（硬體校正機種不帶 vcgt）、per-unit 校正配通用 profile 的出貨死路、VCP 0x14/0xDC/0x02 狀態窗口與 LUT CRC fallback
- [切 HDR 閃怪色、場景一變就偏色？3D LUT 動態插值與模式切換的三個坑]({{ site.baseurl }}{% post_url 2026-11-11-3d-lut-dynamic-interpolation-mode-switch %}) — intermediate — LUT 非原子切換造成混合模式畫面、trilinear vs tetrahedral 插值選型（OCIO INTERP_BEST）、動態插值要在參數域而非 gamma/PQ 域、雙 bank＋CRC＋vblank 單一 commit
- [低亮度 banding、beat 條紋、量測波動？背光 PWM 頻率與 bit depth 的三個取捨]({{ site.baseurl }}{% post_url 2026-11-16-backlight-pwm-frequency-bit-depth-dithering-frc %}) — intermediate — PWM 頻率與 bit depth 物理耦合、duty 下限與最小可調亮度、dithering/FRC 低頻 beat、CA-410 量測陷阱、TÜV Flicker Free 門檻
- [sRGB 模式鎖色域鎖出一堆客訴？gamut clamp 做錯域、hard clip 與 soft mapping 的取捨]({{ site.baseurl }}{% post_url 2026-11-17-gamut-clamp-mapping-srgb-lock %}) — intermediate — clamp 只能做在線性域（gamma 域 clamp 造成色相偏移）、hard clip 的數學合法與視覺災難（膚色死灰）、desaturate-toward-white soft mapping、3D LUT 為正解矩陣為 fallback、HDR Reference White 203 cd/m² 錨點與雙 bank vblank commit
- [暗室 flicker、暖光補成冷光？ALS 自動亮度與色溫補償的 FW 整合]({{ site.baseurl }}{% post_url 2026-11-17-als-auto-brightness-cct-compensation-fw-integration %}) — intermediate — ALS 讀值先 IIR 濾波再映射、單調感知域亮度曲線、hysteresis + slew rate 消 flicker、CCT 補償限幅、ALS 與 PWM 週期對齊、Auto/Manual 切換與偏好記憶
### 系列 E：OSD 與使用者體驗
- [OSD 偶爾卡半秒、久掛又冒黑塊？顯示器韌體的 ISR 與 task 分工三個坑]({{ site.baseurl }}{% post_url 2026-11-04-scaler-fw-architecture-mcu-isr-task-loop %}) — intermediate — Scaler FW 執行模型三層（ISR／task／背景）、ISR 只做記錄與通知、Arm NVIC 優先權數值方向與 `configMAX_SYSCALL_INTERRUPT_PRIORITY` 的關係、固定 block pool 取代執行期 malloc、heartbeat watchdog
- [OTA 斷電變磚？顯示器韌體的 SPI flash dual-bank 與防斷電更新]({{ site.baseurl }}{% post_url 2026-11-04-spi-flash-partition-dual-bank-power-loss-update %}) — intermediate — SPI flash partition 劃分 Bank A/B 與 OSD 資源區、dual-bank 只寫非作用中 bank、CRC 驗證後單一 commit 切換 bank_sel、boot count 與 boot limit 避免開機循環
- [OSD 選單卡半秒、冒黑塊？table-driven 架構與資源壓縮的三個坑]({{ site.baseurl }}{% post_url 2026-11-04-osd-menu-table-driven-architecture-resource-compression %}) — intermediate — 選單表與字串移至 flash 不佔 SRAM、字型/圖示壓縮＋固定 block pool 杜絕 malloc 碎片化、ISR 只設旗標由 task 渲染避免餓死背光 PWM 與 DDC/CI
- [按一下跳兩格、長按沒反應：新手必懂的按鍵 debounce 與 IR repeat]({{ site.baseurl }}{% post_url 2026-11-18-joystick-ir-key-input-debounce %}) — intermediate — integrator counter 去抖動且 ISR 只收件、NEC leader/bit/repeat 三態分流（無 toggle bit 的坑）、joystick 方向隨 VCP 0xAA 旋轉、按鍵改值回報 VCP 0x02 與 host 雙向同步

## Stage 3 — Senior（帶領與攻堅）
### 系列 F：進階介面與認證
- [daisy-chain 第二台螢幕忽然不見？DP sideband message 的 16-byte 分段與通知時序]({{ site.baseurl }}{% post_url 2026-10-30-dp-mst-sideband-daisy-chain %}) — intermediate — MST 拓樸發現走 AUX 的 sideband 訊息、48-byte fragment 與 16-byte AUX 兩層分段、「先寫完才通知」與 ACT handled 置位、HPD 脈寬 0.5–1 ms 的 interop 死角
- [CTS 說你 UHBR10 沒過？128b/132b link training 的 CDS 階段與 DP 2.1 認證工具矩陣]({{ site.baseurl }}{% post_url 2026-10-31-vesa-dp21-cts-phy-link-layer %}) — intermediate — DP 2.1 認證門檻（HBR2+DSC+四選一）、TRAINING_PATTERN_SET 值 3 在 128b/132b 是 TPS2_CDS 不是 TPS3、0x204 EQ/CDS 分開回報、EDID read test 的 0x261 checksum 回寫、VESA 授權測試工具矩陣
- DisplayHDR 送測三連爆：Active Dimming、Subtitle Flicker、Static Contrast 的韌體端根因（即將推出） — intermediate — CTS 1.2 測項地圖與官方 test tool（DisplayHDRTest v1.2）、metadata 驅動 dimming 導致 Active Dimming 不達 stops、duty 與 LCD gain 同 vblank 提交解 Subtitle Flicker、Static Contrast 門檻綁 backlight 架構、logo 授權與版本有效性
- 串接第二台螢幕看 4K 串流黑畫面？HDCP 2.3 repeater 的 READY 時序、seq_num_V 與 key 管理三個坑（即將推出） — intermediate — repeater 的「資料落位→Message_Size→READY」單一順序、seq_num_V 只跟 AKE_Init 走不重用、2 秒 Ack 逾時 set REAUTH_REQ、31 裝置／4 層拓樸上限與 MAX_DEVS/MAX_CASCADE 旗標、key 由安全模組供應商管理與 SRM 撤銷、CTS timeout 表（100/200/20 ms、3 秒、2 秒）
- [送測 HDMI 認證被 ATC 退件？Adopter 資格、CDF 宣告與 FW freeze 的三個流程坑]({{ site.baseurl }}{% post_url 2026-11-04-hdmi-la-adopter-atc-certification-flow %}) — intermediate — HDMI LA／Forum／ATC 三張票的分別、Adopter 四步流程與公司實體資格、self-test 與「每 type 第一個產品送 ATC」義務、CDF/EDID/FW 三方一致性 pre-ATC gate、認證模式鎖定動態行為、ATC pass 不保證互操作
- [接上 Thunderbolt 塢站就閃黑？USB4 DP tunneling 讓 monitor 韌體踩到的三個坑]({{ site.baseurl }}{% post_url 2026-11-04-thunderbolt4-usb4-dp-tunneling-monitor %}) — advanced — USB4 DP IN/OUT adapter 與 tunnel 分層、AUX 45 µs＋10 µs 傳播延遲對上 DPRX 300 µs 預算、EDID RAM shadow 與單一 commit、rate×lane training 矩陣與 stale status、IRQ_HPD 優先的 HPD 退避、TB3-compatible 模式 DSC/FEC 固定為 0 對 4K144 的意義
- [顯示器內建 USB hub 與 KVM 切換：視訊輸入與 USB 上游埠不同步的三個坑]({{ site.baseurl }}{% post_url 2026-11-04-usb-hub-kvm-switch-architecture %}) — intermediate — USB hub tree 架構、KVM 切換時視訊與 USB 上游埠同步、下游埠電源與複位序列、HPD/EDID 重新宣告
- [DP 2.1 UHBR 連結訓練失敗？LTTPR 狀態機與頻率降級 fallback 三個坑]({{ site.baseurl }}{% post_url 2026-11-04-dp21-ltpr-uhbr-link-training-recovery %}) — intermediate — LTTPR 發現、INTRAHOP_AUX_REPLY_INDICATION、128b/132b 頻率降級 fallback 與並行連結訓練（CDS/Hop/Intra-Hop Aux）
- [UHBR20 一過中繼器就訓練失敗？LTTPR one-hot 計數、模式切換序列與 fallback 階梯的三個坑]({{ site.baseurl }}{% post_url 2026-11-18-advanced-lttpr-uhbr20-failure-recovery-state-machine-dp21 %}) — advanced — LTTPR DPCD field 0xF0000 one-hot 計數解碼（kernel drm_dp_lttpr_count）、先透明後非透明的模式切換序列（DP v2.0 §3.6.6.1）、128b/132b 頻率優先 fallback 階梯與 HPD long pulse 收尾
### 系列 G：自動化測試與品質
- [Nightly DP 測試一直 flaky？UniTAP 自動化台的三個前置與追溯坑]({{ site.baseurl }}{% post_url 2026-10-30-unitap-dp-regression-automation %}) — intermediate — HIL regression 的 HPD 前置重置、test library 單一參數來源（UCD Console 流程）、結果綁 build/serial/params_hash、flaky 零容忍與 retry 分層
- [訊號產生器半夜抽風？Quantum Data 882E Telnet 遠端控制的三個坑]({{ site.baseurl }}{% post_url 2026-10-31-quantum-data-siggen-remote-control %}) — intermediate — Telnet IAC（0xFF）協商位元組污染命令流、命令 read-until-prompt 握手與 format change settle、780 系列 USB COM/Disk 模式前置檢查、Python 3.13 移除 telnetlib 的替代做法
- [夜間 DDC/CI regression 卡在 92%？你的腳本把 ddcutil 當同步 RPC 在用]({{ site.baseurl }}{% post_url 2026-10-31-ddcutil-ddci-regression-automation %}) — intermediate — DDC/CI 40–200 ms 等待語意、Null Message 的 not ready vs unsupported 雙語意、setvcp 0x60 verify 必炸、dynamic sleep 統計檔並行污染、退讓重試包裝層與結果追溯
- 校正站重測率飆到 18%？CA-410 與 ArgyllCMS 量測自動化的四個時序與授權坑（即將推出） — intermediate — CA-410 量測速度（0.001 cd/m² 約 1 秒）與自適應 timeout、DDC/CI ack ≠ pipeline 生效（settle ＋ double-buffer commit）、ArgyllCMS 不支援 CA-410 與 KM 通訊規格授權、spotread 的 -O/-N/-X CCMX 腳本化用法
- 夜間壓力測試一斷電就炸？HIL test bench 的 power cycle、USB switch、capture card 三個時序坑（即將推出） — intermediate — power cycle 斷電/settle 實測標定與韌體 system-ready gate、serial port 以 /dev/serial/by-id ＋ pyserial exclusive 綁定、UVC capture card 關自動曝光與多幀 checksum 判斷、結果綁 build/serial/bench/params 四識別
- CI 看板全綠卻是零測試？pytest 接 Jenkins/GitLab 的五個整合坑（即將推出） — intermediate — pytest 結束碼 0–6 逐碼分流（4/5 是假綠燈）、fixture 一動作一 teardown 的 safe structure、GitLab resource_group 跨 pipeline 互斥與節制 retry、--junitxml 接 Jenkins junit step
- 靜態測試圖被報閃爍、HDR 黑畫面連環 fail？capture card 自動偵測腳本的三層根因（即將推出） — intermediate — limited range Y' 16–235 的 quantization range 校正與 percentile 黑畫面判定、V4L2 自動曝光鎖定（V4L2_EXPOSURE_MANUAL）與 noise floor 基準線、timestamp gap 過濾掉 frame 偽閃爍、VCP 0xD6 交叉驗證黑畫面歸因
- 白平衡校正迭代震盪、複驗就翻船？閉式解的數學域、儀器精度與 DDC/CI 寫入時序三個坑（即將推出） — intermediate — xy 比值函數的耦合陷阱與小訊號 Jacobian 閉式解、收斂門檻必須大於 CA-410 儀器精度（±0.002）、DDC/CI ack ≠ 執行與 settle 四步驟、Save Current Settings 漏送造成批量客退、gain 放線性域與 commit-done 狀態
- [訊號產生器沒回你 OK，量到的其實是上一張圖？Chroma 2238 遠端控制與 test pattern 自動化的四個坑]({{ site.baseurl }}{% post_url 2026-11-03-chroma-2238-scpi-test-pattern-automation %}) — intermediate — 2238 公開命令集是 `RUN TIM`/`RUN PTN` 而非 SCPI 查詢模型、0.2 秒換圖時間不等於 DUT 穩定時間、DDC/CI ack 只到匯流排層、三個 gate（DDC/CI 心跳＋量測收斂＋pipeline status）與多模組身分追溯
- [產線校正資料沒綁序號？MES traceability 與 DDC/CI 寫入持久化的三個坑]({{ site.baseurl }}{% post_url 2026-11-03-calibration-traceability-serial-mes-rework %}) — intermediate — 校正資料與 DUT 序號綁定、MES 上傳與 DDC/CI 持久化（scs），避免 rework 找不到原始校正值與斷電遺失
- [四台螢幕一起校反而更慢？多 DUT 並行校正站的排程、儀器鎖與 UPH 瓶頸數學]({{ site.baseurl }}{% post_url 2026-11-04-multi-dut-parallel-calibration-uph %}) — intermediate — 共享儀器互斥鎖與 pyserial exclusive、--bus/--sn 實體位址綁定取代會漂的 --display、ddcutil dynamic sleep 統計檔並行污染、takt = max(量測段, 非量測段/並行度) 的瓶頸公式、CA-410 multi-probe（最多 10 支）與韌體 commit-done 旗標
- Cpk 月報全綠，客訴卻整批偏色？校正結果 SPC 監控的三個資料層陷阱（即將推出） — intermediate — 控制界線與規格界線分開管（NIST §6.3.2）、Cpk 用校正前量測值算並帶 n 檢查（NIST §6.1.6：約 50 筆獨立資料、CI 近似 n≥25、capability study n≥100）、EWMA 抓 drift（λ 0.2–0.3）與 Shewhart+WECO 抓突變的分級告警、站別×probe×面板批次分層、告警綁序號區間回寫 MES
- [產線白平衡校正卡在重測？Chroma 2238 與 CA-410 雙儀器同步 + DDC/CI 閉式校正新手指南]({{ site.baseurl }}{% post_url 2026-11-04-python-chroma-ca410-dual-instrument-sync-test-framework %}) — intermediate — Chroma 2238 為 write-only 非查詢式 SCPI、DDC/CI setvcp ACK 不等於執行完成、CA-410 低灰階量測需分檔 timeout、多 DUT 以 --bus/--sn 綁定實體位址、校正完成需 Save Current Settings 持久化
- [顯示器 FW NPI gate criteria：EVT/DVT/PVT/MP 四階段驗收範本與 EDID/DDC/CI 自動驗收]({{ site.baseurl }}{% post_url 2026-11-04-monitor-npi-gate-criteria-evt-dvt-pvt-mp %}) — intermediate — NPI 四階段 FW 驗收 checklist、EDID/DDC/CI 自動驗收腳本、認證作為 PVT 入口強制條件
- [VCP 0x62 寫下去，動的是喇叭音量：產線白平衡校正的時序、重試與超時]({{ site.baseurl }}{% post_url 2026-11-10-ddci-vcp62-whitebalance-vcp10-brightness-calibration-timing-retry %}) — intermediate — 0x62 在 MCCS 2.2a 是 Audio speaker volume 不是白平衡、白平衡標準碼 16h/18h/1Ah 與 6Ch/6Eh/70h、DDC/CI 40ms 等待／重試 3 次／null message 時序、寫後驗證與 B0h store
- [色溫算出 4667 K、兩站 ΔE 對不上？CA-410 遠端控制與量測換算的四個坑]({{ site.baseurl }}{% post_url 2026-11-12-ca410-command-set-xyy-cct-deltae-automation %}) — intermediate — CA-410 講 KM 自有指令集不是 SCPI（基本命令與 CA-210/310 相容）、McCamy CCT 分母符號 sanity check 寫進 pytest、兩站共用一份 metrics 常數檔且 gate 訂在儀器精度（±0.002／±0.003）之上、量測速度 1／5／20 次/秒分檔與完成碼握手
- [重試三次反而更糟？校正腳本遇上 DDC/CI 匯流排衝突、儀器斷線與 pattern 沒換的三種錯誤分類]({{ site.baseurl }}{% post_url 2026-11-17-calibration-script-fault-tolerance-ddci-bus-conflict-ca410-chroma-retry %}) — intermediate — I2C 是共用資源（ddcutil 2.0 flock 只約束願意配合的客戶端）、bus number 跨開機漂移必須用 EDID 序號重解析、Null Message 的 not ready 與不支援處置相反、CA-410 timeout 後要 drain 重建而非原地重送、2238 的 RUN TIM／RUN PTN write-only 只能用數值範圍＋收斂雙 gate 驗證
### 系列 H：產線與客訴
- [貼紙貼了、燒錄卻沒對上？ISP 燒錄站接 MES 的四個交易邊界坑]({{ site.baseurl }}{% post_url 2026-11-18-factory-isp-flash-mes-integration %}) — advanced — MES 單一發號源與 Reserve/Commit/Supersede 三段交易、OpenOCD program verify 加整段讀回 hash、序號區雙份加 CRC 與 commit 最後寫、outbox 冪等鍵「序號＋attempt」

## Stage 4 — Principal（架構與策略）
### 系列 I：平台架構、選型與專案領導
- [工廠校正站實戰：DUT 掛載檢測與 EDID 前置檢查自動化流程]({{ site.baseurl }}{% post_url 2026-11-16-factory-calibration-station-dut-detection-edid-preflight-rework %}) — intermediate — Python 自動化 Script 結合 ddcutil 實作 DUT 掛載檢測、EDID 讀取前置檢查與校正失敗自動 rework 流程
- [FW Release Management、Versioning 與 Rollback：版本號契約與 A/B 雙 bank]({{ site.baseurl }}{% post_url 2026-11-17-fw-release-management-versioning-rollback %}) — advanced — SemVer 版本號契約、A/B dual-bank test/perm/revert、security counter anti-rollback 與 release manifest
