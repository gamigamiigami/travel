"""メール(SMTP over SSL)への通知。スマホのメール着信で気づく運用向け。"""

from __future__ import annotations

import smtplib
from email.message import EmailMessage
from pathlib import Path

TIMEOUT = 30


class EmailNotifier:
    name = "email"

    def __init__(
        self,
        smtp_host: str = "",
        smtp_port: int = 465,
        username: str = "",
        password: str = "",
        from_addr: str = "",
        to_addr: str = "",
    ) -> None:
        self.smtp_host = smtp_host
        self.smtp_port = int(smtp_port)
        self.username = username
        self.password = password
        self.from_addr = from_addr or username
        self.to_addr = to_addr

    def send(self, title: str, message: str, image_path: Path | None = None) -> bool:
        mail = EmailMessage()
        mail["Subject"] = title
        mail["From"] = self.from_addr
        mail["To"] = self.to_addr
        mail.set_content(message)

        if image_path and Path(image_path).exists():
            mail.add_attachment(
                Path(image_path).read_bytes(),
                maintype="image",
                subtype="png",
                filename=Path(image_path).name,
            )

        with smtplib.SMTP_SSL(self.smtp_host, self.smtp_port, timeout=TIMEOUT) as smtp:
            smtp.login(self.username, self.password)
            smtp.send_message(mail)
        return True
