#!/usr/bin/env python3
"""
Telegram-бот для организации пятничного футбола.

Логика:
- Каждый вторник в 20:00 (МСК) бот публикует анонс игры
- Участники пишут в чат: + / +1 / -
- В пятницу в 12:00 — напоминание
- В пятницу в 18:00 — запись закрывается, публикуется итоговый список
- В пятницу в 20:30 — напоминание «выдвигаемся!»
"""

import os
import logging
import sqlite3
from datetime import datetime

import pytz
from dotenv import load_dotenv
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from telegram import Update
from telegram.ext import (
    Application,
    CommandHandler,
    MessageHandler,
    filters,
    ContextTypes,
)

# ─── Конфигурация ────────────────────────────────────────────────────────────

load_dotenv()

BOT_TOKEN = os.getenv("BOT_TOKEN", "")
GROUP_CHAT_ID = int(os.getenv("GROUP_CHAT_ID", "0"))
MOSCOW_TZ = pytz.timezone("Europe/Moscow")
DB_PATH = os.getenv("DB_PATH", "football.db")

logging.basicConfig(
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)

# ─── База данных ─────────────────────────────────────────────────────────────


def init_db() -> None:
    """Создаёт таблицы при первом запуске."""
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS registrations (
                user_id    INTEGER PRIMARY KEY,
                username   TEXT,
                full_name  TEXT,
                count      INTEGER DEFAULT 1,
                added_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS game_state (
                id           INTEGER PRIMARY KEY DEFAULT 1,
                is_open      INTEGER DEFAULT 0
            )
        """)
        conn.execute("INSERT OR IGNORE INTO game_state (id, is_open) VALUES (1, 0)")
        conn.commit()


def _is_registration_open() -> bool:
    with sqlite3.connect(DB_PATH) as conn:
        row = conn.execute("SELECT is_open FROM game_state WHERE id = 1").fetchone()
    return bool(row and row[0])


def _set_registration_open(value: bool) -> None:
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("UPDATE game_state SET is_open = ? WHERE id = 1", (int(value),))
        conn.commit()


def _register(user_id: int, username: str, full_name: str, count: int) -> None:
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("""
            INSERT INTO registrations (user_id, username, full_name, count, added_at)
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(user_id) DO UPDATE SET
                username  = excluded.username,
                full_name = excluded.full_name,
                count     = excluded.count,
                added_at  = CURRENT_TIMESTAMP
        """, (user_id, username, full_name, count))
        conn.commit()


def _unregister(user_id: int) -> bool:
    with sqlite3.connect(DB_PATH) as conn:
        cur = conn.execute("DELETE FROM registrations WHERE user_id = ?", (user_id,))
        conn.commit()
    return cur.rowcount > 0


def _get_all() -> list[tuple]:
    with sqlite3.connect(DB_PATH) as conn:
        return conn.execute(
            "SELECT user_id, username, full_name, count FROM registrations ORDER BY added_at"
        ).fetchall()


def _total() -> int:
    return sum(r[3] for r in _get_all())


def _clear_all() -> None:
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("DELETE FROM registrations")
        conn.commit()


# ─── Форматирование списка ───────────────────────────────────────────────────


def _build_list_text() -> str:
    rows = _get_all()
    if not rows:
        return "😔 Пока никто не записался."

    lines = []
    n = 1
    for _, username, full_name, count in rows:
        name = full_name or username or "Неизвестный"
        if count == 1:
            lines.append(f"{n}. {name}")
            n += 1
        else:
            lines.append(f"{n}. {name} (+1 друг)")
            n += 2

    total = sum(r[3] for r in rows)
    lines.append(f"\n👥 Всего: *{total}* чел.")

    full_teams = total // 5
    remainder = total % 5

    if full_teams > 0:
        team_word = ("команда" if full_teams == 1
                     else "команды" if full_teams < 5
                     else "команд")
        lines.append(f"⚽ {full_teams} {team_word} по 5" +
                     (f" + {remainder} в запасе" if remainder else ""))
    else:
        lines.append(f"⚽ Нужно ещё {5 - total} чел. до первой команды")

    return "\n".join(lines)


# ─── Запланированные события ─────────────────────────────────────────────────


async def job_announce(bot) -> None:
    """Вторник 20:00 — открыть запись и опубликовать анонс."""
    _clear_all()
    _set_registration_open(True)
    text = (
        "⚽ *Пятница в 21:00 — играем в футбол!*\n\n"
        "Напиши в чат:\n"
        "✅ *+*  — иду\n"
        "✅ *+1* — иду и веду друга\n"
        "❌ *-*  — отмена _(не позже 18:00 в пятницу)_\n\n"
        "Играем пятёрками 🏃 Команды собираются автоматически!"
    )
    await bot.send_message(chat_id=GROUP_CHAT_ID, text=text, parse_mode="Markdown")
    logger.info("Анонс опубликован, запись открыта.")


async def job_friday_reminder(bot) -> None:
    """Пятница 12:00 — напоминание."""
    total = _total()
    rows = _get_all()
    if not rows:
        text = "⚠️ *Сегодня в 21:00 — футбол!*\nЕщё никто не записался. Кто идёт?"
    else:
        full_teams = total // 5
        text = (
            f"⚽ *Напоминание! Сегодня в 21:00 — футбол!*\n\n"
            f"Записалось: *{total}* чел."
        )
        if full_teams:
            text += f" ({full_teams} команд{'а' if full_teams == 1 else 'ы' if full_teams < 5 else ''})"
        text += "\n\n❌ Отмена — пишите *-* не позже 18:00"
    await bot.send_message(chat_id=GROUP_CHAT_ID, text=text, parse_mode="Markdown")


async def job_close_registration(bot) -> None:
    """Пятница 18:00 — закрыть запись, опубликовать финальный список."""
    _set_registration_open(False)
    rows = _get_all()
    if not rows:
        await bot.send_message(
            chat_id=GROUP_CHAT_ID,
            text="🔒 Запись закрыта. Никто не записался — игры не будет 😔"
        )
        return

    text = "🔒 *Запись закрыта! Финальный список:*\n\n"
    text += _build_list_text()
    text += "\n\n⏰ Встречаемся в *21:00*! Удачи всем ⚽"
    await bot.send_message(chat_id=GROUP_CHAT_ID, text=text, parse_mode="Markdown")
    logger.info("Запись закрыта, итоговый список опубликован.")


async def job_starting_soon(bot) -> None:
    """Пятница 20:30 — напоминание «через 30 минут»."""
    if _total() > 0:
        await bot.send_message(
            chat_id=GROUP_CHAT_ID,
            text="🏃 *Через 30 минут — футбол! Выдвигаемся!* ⚽",
            parse_mode="Markdown",
        )


# ─── Обработчики команд и сообщений ──────────────────────────────────────────


async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text(
        "Привет! Я слежу за пятничным футболом ⚽\n\n"
        "Пиши в чат группы:\n"
        "*+*  — записаться\n"
        "*+1* — записаться с другом\n"
        "*-*  — отмена (до 18:00 в пятницу)\n\n"
        "*/status* — текущий список\n"
        "*/help*   — справка",
        parse_mode="Markdown",
    )


async def cmd_help(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text(
        "📖 *Справка*\n\n"
        "• *+* — записаться на игру\n"
        "• *+1* — записаться вместе с другом (считается 2 человека)\n"
        "• *-* — отменить участие (только до 18:00 в пятницу!)\n\n"
        "*/status* — посмотреть, кто записался\n\n"
        "Бот сам напишет анонс во *вторник в 20:00* и закроет запись в *пятницу в 18:00*.",
        parse_mode="Markdown",
    )


async def cmd_status(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    is_open = _is_registration_open()
    header = "📋 *Список участников:*\n\n" if is_open else "📋 *Список участников (запись закрыта):*\n\n"
    await update.message.reply_text(
        header + _build_list_text(),
        parse_mode="Markdown",
    )


async def handle_text(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Обрабатывает +, +1, - в чате группы."""
    if not update.message or not update.message.text:
        return

    raw = update.message.text.strip()
    user = update.message.from_user
    uid = user.id
    uname = user.username or ""
    fname = user.full_name or uname or f"id{uid}"

    # ── Запись: +
    if raw in ("+", "＋"):
        if not _is_registration_open():
            await update.message.reply_text("⏰ Запись сейчас закрыта.")
            return
        _register(uid, uname, fname, 1)
        total = _total()
        await update.message.reply_text(
            f"✅ {fname}, ты в списке!\n👥 Записалось: {total} чел."
        )

    # ── Запись с другом: +1
    elif raw in ("+1", "+ 1", "＋1"):
        if not _is_registration_open():
            await update.message.reply_text("⏰ Запись сейчас закрыта.")
            return
        _register(uid, uname, fname, 2)
        total = _total()
        await update.message.reply_text(
            f"✅ {fname} + друг — вы в списке!\n👥 Записалось: {total} чел."
        )

    # ── Отмена: -
    elif raw == "-":
        if not _is_registration_open():
            await update.message.reply_text("⏰ Запись уже закрыта, отмена невозможна.")
            return
        # Отмена не позже 18:00 в пятницу
        now = datetime.now(MOSCOW_TZ)
        if now.weekday() == 4 and now.hour >= 18:
            await update.message.reply_text("⏰ Отмена возможна только до 18:00 в пятницу.")
            return
        was_in = _unregister(uid)
        total = _total()
        if was_in:
            await update.message.reply_text(
                f"❌ {fname}, ты удалён из списка.\n👥 Осталось: {total} чел."
            )
        else:
            await update.message.reply_text("Тебя и так не было в списке.")


# ─── Точка входа ─────────────────────────────────────────────────────────────


def main() -> None:
    if not BOT_TOKEN:
        raise RuntimeError("BOT_TOKEN не задан! Проверь файл .env")
    if not GROUP_CHAT_ID:
        raise RuntimeError("GROUP_CHAT_ID не задан! Проверь файл .env")

    init_db()

    app = Application.builder().token(BOT_TOKEN).build()

    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("help", cmd_help))
    app.add_handler(CommandHandler("status", cmd_status))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_text))

    scheduler = AsyncIOScheduler(timezone=MOSCOW_TZ)

    # Вторник 20:00 — анонс и открытие записи
    scheduler.add_job(
        job_announce,
        CronTrigger(day_of_week="tue", hour=20, minute=0, timezone=MOSCOW_TZ),
        args=[app.bot],
        id="announce",
    )
    # Пятница 12:00 — напоминание
    scheduler.add_job(
        job_friday_reminder,
        CronTrigger(day_of_week="fri", hour=12, minute=0, timezone=MOSCOW_TZ),
        args=[app.bot],
        id="reminder",
    )
    # Пятница 18:00 — закрытие записи
    scheduler.add_job(
        job_close_registration,
        CronTrigger(day_of_week="fri", hour=18, minute=0, timezone=MOSCOW_TZ),
        args=[app.bot],
        id="close",
    )
    # Пятница 20:30 — «выдвигаемся»
    scheduler.add_job(
        job_starting_soon,
        CronTrigger(day_of_week="fri", hour=20, minute=30, timezone=MOSCOW_TZ),
        args=[app.bot],
        id="soon",
    )

    scheduler.start()
    logger.info("Бот запущен. Ожидаю сообщения...")
    app.run_polling(drop_pending_updates=True)


if __name__ == "__main__":
    main()
