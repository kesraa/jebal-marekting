# CLAUDE.md

## إرسال رسائل WhatsApp

- أي طلب إرسال واتساب (مثل: "ابعت لرقم..."، "ارسل للعميل..."، "قوله...") يُنفّذ فقط عبر:
  `POST https://wa-bridge.aeronotic-eng-mahmoud.workers.dev/send`
- الـBody يحتوي فقط على:
  ```json
  { "to": "رقم المستلم", "message": "نص الرسالة" }
  ```
- رقم المرسل يُحدَّد تلقائيًا من `PHONE_NUMBER_ID` المخزّن في Cloudflare. لا تسأل عن رقم المرسل، ولا تعرض اختيار رقم آخر إلا إذا طلب المستخدم ذلك صراحة.
- لا تستخدم WhatsApp Business Tools (MCP) ولا `graph.facebook.com` مباشرة للإرسال.
- لا تغيّر أي إعداد في الـWorker أو Cloudflare، ولا تنشئ endpoints جديدة.
- رقم المستخدم الشخصي: `201065047002`. أي طلب مثل "ابعت لي" أو "على الواتس بتاعي" يُرسل إلى هذا الرقم.
- بعد كل إرسال، أعطِ المستخدم HTTP status والـresponse (أو الـmessage id).
