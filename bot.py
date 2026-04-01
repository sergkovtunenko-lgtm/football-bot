#!/usr/bin/env python3
"""
Telegram-бот для организации игры в манеже Пингвин.

Команды администратора:
  /начать    — открыть регистрацию и отправить анонс в группу
  /завершить — закрыть регистрацию, разбить на команды, показать топ-15
  /сброс     — очистить все данные (для следующей игры)

Команды всех участников:
  +          — записаться
  +1/+2/+3   — записаться с друзьями
  -          — отменить запись
  итог       — счёт за вечер
  1, 2...    — победила эта команда
  /status    — текущий список
"""

import asyncio
import datetime
import html
import os
import random
import logging
import sqlite3
from contextlib import contextmanager
from typing import Generator

import pytz
from dotenv import load_dotenv
from telegram import Update, Message
from telegram.error import NetworkError, TimedOut, RetryAfter
from telegram.ext import (
    Application,
    CommandHandler,
    MessageHandler,
    filters,
    ContextTypes,
)

# ─── Конфигурация ────────────────────────────────────────────────────────────

load_dotenv()

BOT_TOKEN     = os.getenv("BOT_TOKEN", "")
GROUP_CHAT_ID = int(os.getenv("GROUP_CHAT_ID", "0"))
ADMIN_ID      = int(os.getenv("ADMIN_ID", "471691551"))
MOSCOW_TZ     = pytz.timezone("Europe/Moscow")
DB_PATH       = os.getenv("DB_PATH", "football.db")
MAX_PLAYERS   = 20

logging.basicConfig(
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)

# ─── Менеджер соединений с БД ────────────────────────────────────────────────

@contextmanager
def _db(immediate: bool = False) -> Generator[sqlite3.Connection, None, None]:
    """
    Открывает соединение, начинает транзакцию, фиксирует или откатывает.
    immediate=True → BEGIN IMMEDIATE (исключает race condition при записи)
    immediate=False → BEGIN (для чтения)
    """
    conn = sqlite3.connect(DB_PATH, isolation_level=None)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("BEGIN IMMEDIATE" if immediate else "BEGIN")
        yield conn
        conn.execute("COMMIT")
    except Exception:
        try:
            conn.execute("ROLLBACK")
        except Exception:
            pass
        raise
    finally:
        conn.close()


# ─── Инициализация БД ────────────────────────────────────────────────────────

def init_db() -> None:
    # WAL-режим нельзя включать внутри транзакции
    conn = sqlite3.connect(DB_PATH, isolation_level=None)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.close()

    with _db(immediate=True) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS registrations (
                user_id          INTEGER PRIMARY KEY,
                username         TEXT,
                full_name        TEXT,
                has_guest        INTEGER DEFAULT 0,
                is_reserve       INTEGER DEFAULT 0,
                guest_is_reserve INTEGER DEFAULT 0,
                added_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS game_state (
                id           INTEGER PRIMARY KEY DEFAULT 1,
                is_open      INTEGER DEFAULT 0,
                teams_active INTEGER DEFAULT 0
            )
        """)
        conn.execute("INSERT OR IGNORE INTO game_state (id) VALUES (1)")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS teams (
                team_number INTEGER,
                user_id     INTEGER,
                username    TEXT,
                full_name   TEXT
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS wins_tonight (
                user_id    INTEGER PRIMARY KEY,
                username   TEXT,
                full_name  TEXT,
                wins       INTEGER DEFAULT 0
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS all_time_stats (
                user_id   INTEGER PRIMARY KEY,
                username  TEXT,
                full_name TEXT,
                reg_count INTEGER DEFAULT 0
            )
        """)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_reg_reserve_time "
            "ON registrations(is_reserve, added_at)"
        )


# ─── Операции с БД ───────────────────────────────────────────────────────────

def _get_state() -> tuple[int, int]:
    with _db() as conn:
        row = conn.execute(
            "SELECT is_open, teams_active FROM game_state WHERE id=1"
        ).fetchone()
    return (row["is_open"], row["teams_active"]) if row else (0, 0)


def _set_state(is_open: int | None = None, teams_active: int | None = None) -> None:
    with _db(immediate=True) as conn:
        if is_open is not None and teams_active is not None:
            conn.execute(
                "UPDATE game_state SET is_open=?, teams_active=? WHERE id=1",
                (is_open, teams_active),
            )
        elif is_open is not None:
            conn.execute("UPDATE game_state SET is_open=? WHERE id=1", (is_open,))
        elif teams_active is not None:
            conn.execute("UPDATE game_state SET teams_active=? WHERE id=1", (teams_active,))


def _register(user_id: int, username: str, full_name: str, has_guest: int) -> dict:
    """Атомарная регистрация игрока (BEGIN IMMEDIATE)."""
    with _db(immediate=True) as conn:
        existing = conn.execute(
            "SELECT is_reserve, has_guest, guest_is_reserve "
            "FROM registrations WHERE user_id=?",
            (user_id,),
        ).fetchone()

        rows = conn.execute(
            "SELECT has_guest, guest_is_reserve FROM registrations WHERE is_reserve=0"
        ).fetchall()
        current_main = sum(1 + r["has_guest"] - r["guest_is_reserve"] for r in rows)

        is_new = existing is None
        if existing and not existing["is_reserve"]:
            current_main -= (1 + existing["has_guest"] - existing["guest_is_reserve"])

        free = MAX_PLAYERS - current_main
        total_needed = 1 + has_guest

        if free <= 0:
            is_reserve, guest_is_reserve, status = 1, 0, "reserve"
        elif free >= total_needed:
            is_reserve, guest_is_reserve, status = 0, 0, "main"
        else:
            is_reserve, guest_is_reserve, status = 0, total_needed - free, "partial"

        now = datetime.datetime.now().isoformat()
        conn.execute(
            """
            INSERT INTO registrations
                (user_id, username, full_name, has_guest,
                 is_reserve, guest_is_reserve, added_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
                username         = excluded.username,
                full_name        = excluded.full_name,
                has_guest        = excluded.has_guest,
                is_reserve       = excluded.is_reserve,
                guest_is_reserve = excluded.guest_is_reserve
            """,
            (user_id, username, full_name, has_guest, is_reserve, guest_is_reserve, now),
        )

        if is_new:
            conn.execute(
                """
                INSERT INTO all_time_stats (user_id, username, full_name, reg_count)
                VALUES (?, ?, ?, 1)
                ON CONFLICT(user_id) DO UPDATE SET
                    username  = excluded.username,
                    full_name = excluded.full_name,
                    reg_count = reg_count + 1
                """,
                (user_id, username, full_name),
            )

    return {"status": status, "guest_is_reserve": guest_is_reserve, "has_guest": has_guest}


def _unregister(user_id: int) -> tuple[bool, list[str]]:
    """Атомарное удаление + продвижение резерва (BEGIN IMMEDIATE)."""
    with _db(immediate=True) as conn:
        row = conn.execute(
            "SELECT is_reserve, has_guest, guest_is_reserve "
            "FROM registrations WHERE user_id=?",
            (user_id,),
        ).fetchone()

        if not row:
            return False, []

        freed = 0 if row["is_reserve"] else (
            1 + row["has_guest"] - row["guest_is_reserve"]
        )
        conn.execute("DELETE FROM registrations WHERE user_id=?", (user_id,))
        promoted = _promote_in_txn(conn, freed) if freed > 0 else []

    return True, promoted


def _promote_in_txn(conn: sqlite3.Connection, slots: int) -> list[str]:
    """Продвигает игроков из резерва внутри уже открытой транзакции."""
    promoted: list[str] = []

    while slots > 0:
        row = conn.execute(
            "SELECT user_id, username, full_name FROM registrations "
            "WHERE is_reserve=0 AND guest_is_reserve > 0 ORDER BY added_at LIMIT 1"
        ).fetchone()
        if not row:
            break
        display = _display_name(row["username"], row["full_name"], row["user_id"])
        conn.execute(
            "UPDATE registrations SET guest_is_reserve=guest_is_reserve-1 WHERE user_id=?",
            (row["user_id"],),
        )
        slots -= 1
        promoted.append(f"гость ({display})")

    while slots > 0:
        row = conn.execute(
            "SELECT user_id, username, full_name, has_guest FROM registrations "
            "WHERE is_reserve=1 ORDER BY added_at LIMIT 1"
        ).fetchone()
        if not row:
            break

        uid = row["user_id"]
        display = _display_name(row["username"], row["full_name"], uid)
        total_needed = 1 + row["has_guest"]

        if slots >= total_needed:
            conn.execute(
                "UPDATE registrations SET is_reserve=0, guest_is_reserve=0 WHERE user_id=?",
                (uid,),
            )
            slots -= total_needed
            suffix = f" + {_guest_word(row['has_guest'])}" if row["has_guest"] else ""
            promoted.append(f"{display}{suffix}")
        elif slots >= 1:
            guests_in_res = total_needed - slots
            conn.execute(
                "UPDATE registrations SET is_reserve=0, guest_is_reserve=? WHERE user_id=?",
                (guests_in_res, uid),
            )
            promoted.append(
                f"{display} ({guests_in_res} гост. в резерве)" if guests_in_res else display
            )
            slots = 0
        else:
            break

    return promoted


def _clear_all() -> None:
    """Полный сброс перед новой игрой."""
    with _db(immediate=True) as conn:
        conn.execute("DELETE FROM registrations")
        conn.execute("DELETE FROM teams")
        conn.execute("DELETE FROM wins_tonight")
        conn.execute("UPDATE game_state SET is_open=0, teams_active=0 WHERE id=1")


def _clear_round() -> None:
    """Сброс только результатов матчей (без регистраций)."""
    with _db(immediate=True) as conn:
        conn.execute("DELETE FROM teams")
        conn.execute("DELETE FROM wins_tonight")


# ─── Форматирование ──────────────────────────────────────────────────────────

def _display_name(username: str | None, full_name: str | None, user_id: int) -> str:
    if username:
        return f"@{html.escape(str(username))}"
    return html.escape(str(full_name)) if full_name else f"id{user_id}"


def _guest_word(count: int) -> str:
    if count == 1:
        return "1 гость"
    if count in (2, 3, 4):
        return f"{count} гостя"
    return f"{count} гостей"


def _reg_message(display: str, reg: dict) -> str:
    hg, status, gir = reg["has_guest"], reg["status"], reg["guest_is_reserve"]
    if hg == 0:
        return (
            f"✅ {display} — в основном составе!"
            if status == "main"
            else f"⏳ {display} — в резерве (основной состав заполнен)."
        )
    gw = _guest_word(hg)
    if status == "main":
        return f"✅ {display} + {gw} — все в основном составе!"
    if status == "partial":
        gm = hg - gir
        if gm > 0:
            return (
                f"✅ {display} + {_guest_word(gm)} — в основном составе.\n"
                f"⏳ {_guest_word(gir)} — в резерве."
            )
        return f"✅ {display} — в основном составе.\n⏳ {gw} — в резерве."
    return f"⏳ {display} + {gw} — все в резерве."


def _build_player_list() -> str:
    """Единый снимок БД — список всегда согласован."""
    with _db() as conn:
        main = conn.execute(
            "SELECT user_id, username, full_name, has_guest, guest_is_reserve "
            "FROM registrations WHERE is_reserve=0 ORDER BY added_at"
        ).fetchall()
        reserve = conn.execute(
            "SELECT user_id, username, full_name, has_guest "
            "FROM registrations WHERE is_reserve=1 ORDER BY added_at"
        ).fetchall()

    total_main = sum(1 + r["has_guest"] - r["guest_is_reserve"] for r in main)
    lines: list[str] = []
    n = 1

    if main:
        lines.append(f"📋 <b>Основной состав ({total_main}/{MAX_PLAYERS}):</b>")
        for r in main:
            name = _display_name(r["username"], r["full_name"], r["user_id"])
            lines.append(f"{n}. {name}")
            n += 1
            for _ in range(r["has_guest"] - r["guest_is_reserve"]):
                lines.append(f"{n}. гость ({name})")
                n += 1
            for _ in range(r["guest_is_reserve"]):
                lines.append(f"  ↳ гость ({name}) — в резерве")

        full_teams, rem = divmod(total_main, 5)
        if full_teams:
            word = "команда" if full_teams == 1 else "команды" if full_teams < 5 else "команд"
            lines.append(
                f"\n⚽ {full_teams} {word} по 5"
                + (f" + {rem} в запасе" if rem else "")
            )
        else:
            lines.append(f"\n⚽ Нужно ещё {5 - total_main} до первой команды")
    else:
        lines.append("😔 Пока никто не записался.")

    if reserve:
        res_lines: list[str] = []
        r_n = 1
        for r in reserve:
            name = _display_name(r["username"], r["full_name"], r["user_id"])
            res_lines.append(f"{r_n}. {name}")
            r_n += 1
            for _ in range(r["has_guest"]):
                res_lines.append(f"{r_n}. гость ({name})")
                r_n += 1
        lines.append(f"\n⏳ <b>Резерв ({r_n - 1} чел.):</b>")
        lines.extend(res_lines)

    lines.append(
        "\n\n📌 <b>Запись:</b> "
        "<b>+</b> (иду), <b>+1</b> (иду с другом), "
        "<b>+2</b> (иду с 2 друзьями), <b>+3</b> (иду с 3 друзьями), "
        "<b>-</b> (не приду)"
    )
    return "\n".join(lines)


def _build_top_players() -> str:
    with _db() as conn:
        rows = conn.execute(
            "SELECT username, full_name, user_id, reg_count "
            "FROM all_time_stats ORDER BY reg_count DESC LIMIT 15"
        ).fetchall()
    if not rows:
        return "Пока нет данных."
    medals = ["🥇", "🥈", "🥉"]
    lines = []
    for i, r in enumerate(rows):
        medal = medals[i] if i < 3 else f"{i + 1}."
        name = _display_name(r["username"], r["full_name"], r["user_id"])
        cnt = r["reg_count"]
        word = "раз" if cnt == 1 else "раза" if cnt < 5 else "раз"
        lines.append(f"{medal} {name} — {cnt} {word}")
    return "\n".join(lines)


def _build_standings() -> str:
    with _db() as conn:
        rows = conn.execute(
            "SELECT username, full_name, user_id, wins "
            "FROM wins_tonight ORDER BY wins DESC"
        ).fetchall()
    if not rows:
        return "Пока нет результатов."
    medals = ["🥇", "🥈", "🥉"]
    lines = []
    for i, r in enumerate(rows):
        medal = medals[i] if i < 3 else f"{i + 1}."
        name = _display_name(r["username"], r["full_name"], r["user_id"])
        w = r["wins"]
        word = "победа" if w == 1 else "победы" if w < 5 else "побед"
        lines.append(f"{medal} {name} — {w} {word}")
    return "\n".join(lines)


# ─── Команды ─────────────────────────────────────────────────────────────────

def _make_and_save_teams() -> list[list]:
    with _db() as conn:
        rows = conn.execute(
            "SELECT user_id, username, full_name, has_guest, guest_is_reserve "
            "FROM registrations WHERE is_reserve=0 ORDER BY added_at"
        ).fetchall()

    players = []
    for r in rows:
        name = _display_name(r["username"], r["full_name"], r["user_id"])
        players.append((r["user_id"], r["username"], r["full_name"], name))
        for _ in range(r["has_guest"] - r["guest_is_reserve"]):
            players.append((None, None, f"гость ({name})", f"гость ({name})"))

    random.shuffle(players)
    teams = [players[i: i + 5] for i in range(0, len(players), 5)]

    with _db(immediate=True) as conn:
        conn.execute("DELETE FROM teams")
        for num, members in enumerate(teams, start=1):
            for uid, uname, fname, display in members:
                conn.execute(
                    "INSERT INTO teams (team_number, user_id, username, full_name) VALUES (?,?,?,?)",
                    (num, uid, uname, display),
                )
    return teams


def _format_teams(teams: list[list]) -> str:
    lines = ["🎲 <b>Случайные команды:</b>\n"]
    for i, members in enumerate(teams, start=1):
        lines.append(f"<b>Команда {i}:</b>")
        for j, (_, _, _, display) in enumerate(members, start=1):
            lines.append(f"  {j}. {display}")
        lines.append("")
    lines.append(
        "Результат игры: напиши номер победившей команды "
        "(<b>1</b>, <b>2</b>, <b>3</b>...)"
    )
    return "\n".join(lines)


def _get_total_teams() -> int:
    with _db() as conn:
        row = conn.execute("SELECT MAX(team_number) AS m FROM teams").fetchone()
    return row["m"] or 0


def _record_win(team_number: int) -> list[str]:
    with _db(immediate=True) as conn:
        members = conn.execute(
            "SELECT user_id, username, full_name FROM teams WHERE team_number=?",
            (team_number,),
        ).fetchall()
        names = []
        for r in members:
            if r["user_id"] is None:
                continue
            display = _display_name(r["username"], r["full_name"], r["user_id"])
            names.append(display)
            conn.execute(
                """
                INSERT INTO wins_tonight (user_id, username, full_name, wins)
                VALUES (?, ?, ?, 1)
                ON CONFLICT(user_id) DO UPDATE SET wins = wins + 1
                """,
                (r["user_id"], r["username"], r["full_name"]),
            )
    return names


# ─── Telegram helpers ────────────────────────────────────────────────────────

async def _safe_send(
    message: Message,
    text: str,
    parse_mode: str = "HTML",
    retries: int = 3,
) -> None:
    """Отправляет сообщение с retry при сетевых ошибках."""
    for attempt in range(retries):
        try:
            await message.reply_text(text, parse_mode=parse_mode)
            return
        except RetryAfter as e:
            await asyncio.sleep(e.retry_after + 1)
        except (NetworkError, TimedOut) as e:
            if attempt < retries - 1:
                await asyncio.sleep(1.5 ** attempt)
            else:
                logger.error(f"Не удалось отправить сообщение: {e}")
                raise


async def _is_admin(uid: int, bot, chat_id: int) -> bool:
    if uid == ADMIN_ID:
        return True
    try:
        member = await bot.get_chat_member(chat_id, uid)
        return member.status in ("administrator", "creator")
    except Exception:
        return False


# ─── Команды администратора ──────────────────────────────────────────────────

async def cmd_nachat(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """/начать — открыть регистрацию и отправить анонс в группу."""
    try:
        uid = update.message.from_user.id
        if not await _is_admin(uid, context.bot, GROUP_CHAT_ID):
            await _safe_send(update.message, "⛔ Только для администраторов.")
            return

        is_open, _ = _get_state()
        if is_open:
            # Регистрация уже открыта — просто показываем текущий список
            await _safe_send(
                update.message,
                "ℹ️ Регистрация уже открыта. Текущий список:\n\n" + _build_player_list(),
            )
            return

        # Открываем регистрацию (существующие записи сохраняются)
        _set_state(is_open=1, teams_active=0)

        # Анонс в группу
        announcement = (
            "⚽ <b>Открыта запись на футбол в манеже Пингвин!</b>\n\n"
            "📌 <b>Как записаться — напиши в этот чат:</b>\n"
            "✅ <b>+</b>  — я иду\n"
            "✅ <b>+1</b> — иду и беру с собой 1 друга\n"
            "✅ <b>+2</b> — иду и беру с собой 2 друзей\n"
            "✅ <b>+3</b> — иду и беру с собой 3 друзей\n"
            "❌ <b>-</b>  — не приду / отменить запись\n\n"
            f"👥 Основной состав — первые <b>{MAX_PLAYERS} человек</b>.\n"
            "Остальные попадают в резерв и автоматически переходят в основной состав, "
            "если кто-то отменяет запись.\n\n"
            "Команды делятся случайно по 5 человек. Играем пятёрками 🏃"
        )

        # Если команда написана в группе — отправляем анонс туда же
        # Если в личке — шлём в группу отдельно и подтверждаем
        if update.message.chat_id == GROUP_CHAT_ID:
            await _safe_send(update.message, announcement)
        else:
            await context.bot.send_message(
                chat_id=GROUP_CHAT_ID, text=announcement, parse_mode="HTML"
            )
            await _safe_send(update.message, "✅ Анонс отправлен в группу.")

        # Показываем тех, кто уже в списке (если есть)
        with _db() as conn:
            count = conn.execute("SELECT COUNT(*) AS c FROM registrations").fetchone()["c"]

        if count > 0:
            await _safe_send(
                update.message,
                f"📋 Уже записались ({count} чел.):\n\n" + _build_player_list(),
            )

        logger.info(f"Регистрация открыта администратором {uid}.")

    except Exception as e:
        logger.error(f"cmd_nachat error: {e}", exc_info=True)
        try:
            await update.message.reply_text("⚠️ Что-то пошло не так. Попробуй ещё раз.")
        except Exception:
            pass


async def cmd_zavershit(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """/завершить — закрыть запись, разбить на команды, показать топ-15."""
    try:
        uid = update.message.from_user.id
        if not await _is_admin(uid, context.bot, GROUP_CHAT_ID):
            await _safe_send(update.message, "⛔ Только для администраторов.")
            return

        is_open, _ = _get_state()
        if not is_open:
            await _safe_send(update.message, "Запись уже закрыта.")
            return

        _set_state(is_open=0, teams_active=1)

        with _db() as conn:
            has_players = conn.execute(
                "SELECT 1 FROM registrations WHERE is_reserve=0 LIMIT 1"
            ).fetchone()

        if not has_players:
            await _safe_send(update.message, "🔒 Запись закрыта. Никто не записался.")
            return

        final_text = (
            "🔒 <b>Запись закрыта! Финальный список:</b>\n\n"
            + _build_player_list()
            + "\n\n⏰ Встречаемся в манеже Пингвин! ⚽"
        )
        await _safe_send(update.message, final_text)

        teams = _make_and_save_teams()
        await _safe_send(update.message, _format_teams(teams))

        await _safe_send(
            update.message,
            "🌟 <b>Топ-15 самых активных игроков за всё время:</b>\n\n"
            + _build_top_players(),
        )

    except Exception as e:
        logger.error(f"cmd_zavershit error: {e}", exc_info=True)
        try:
            await update.message.reply_text("⚠️ Что-то пошло не так. Попробуй ещё раз.")
        except Exception:
            pass


async def cmd_sbros(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """/сброс — очистить все данные перед новой игрой."""
    try:
        uid = update.message.from_user.id
        if not await _is_admin(uid, context.bot, GROUP_CHAT_ID):
            await _safe_send(update.message, "⛔ Только для администраторов.")
            return

        _clear_all()
        await _safe_send(
            update.message,
            "🗑 Все данные сброшены. Можно начинать новую игру — /начать",
        )
        logger.info(f"Данные сброшены администратором {uid}.")

    except Exception as e:
        logger.error(f"cmd_sbros error: {e}", exc_info=True)


# ─── Общие команды ───────────────────────────────────────────────────────────

async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    try:
        uid = update.message.from_user.id
        is_admin = await _is_admin(uid, context.bot, GROUP_CHAT_ID)

        admin_section = (
            "\n\n🔧 <b>Команды администратора:</b>\n"
            "/начать — открыть регистрацию\n"
            "/завершить — закрыть запись и разбить на команды\n"
            "/сброс — очистить всё перед новой игрой"
            if is_admin else ""
        )

        await _safe_send(
            update.message,
            "Привет! Я бот манежа Пингвин ⚽\n\n"
            "В чате группы пиши:\n"
            "<b>+</b> — записаться\n"
            "<b>+1</b> — я и 1 друг\n"
            "<b>+2</b> — я и 2 друга\n"
            "<b>+3</b> — я и 3 друга\n"
            "<b>-</b> — отмена записи\n"
            "<b>итог</b> — счёт за сегодня\n"
            "<b>/status</b> — текущий список"
            + admin_section,
        )
    except Exception as e:
        logger.error(f"cmd_start error: {e}", exc_info=True)


async def cmd_status(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    try:
        is_open, _ = _get_state()
        header = (
            "📋 <b>Список участников:</b>\n\n"
            if is_open
            else "📋 <b>Список (запись закрыта):</b>\n\n"
        )
        await _safe_send(update.message, header + _build_player_list())
    except Exception as e:
        logger.error(f"cmd_status error: {e}", exc_info=True)


# ─── Обработчик текстовых сообщений ─────────────────────────────────────────

async def handle_text(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    try:
        if not update.message or not update.message.text:
            return

        # Только сообщения из целевой группы
        if update.message.chat_id != GROUP_CHAT_ID:
            return

        raw = update.message.text.strip()
        raw_lower = raw.lower()
        user = update.message.from_user
        uid = user.id
        uname = user.username or ""
        fname = user.full_name or uname or f"id{uid}"
        display = _display_name(uname, fname, uid)

        is_open, teams_active = _get_state()

        # ── «завершить» (текстовая версия для обратной совместимости) ─────
        if raw_lower == "завершить":
            if not await _is_admin(uid, context.bot, GROUP_CHAT_ID):
                return
            # Делегируем в cmd_zavershit
            await cmd_zavershit(update, context)
            return

        # ── Номер победившей команды ────────────────────────────────────────
        if raw.isdigit() and teams_active:
            team_num = int(raw)
            max_teams = _get_total_teams()
            if team_num < 1 or team_num > max_teams:
                await _safe_send(
                    update.message,
                    f"Команд всего {max_teams}. Укажи число от 1 до {max_teams}.",
                )
                return
            winners = _record_win(team_num)
            names_str = ", ".join(winners) if winners else "—"
            await _safe_send(
                update.message,
                f"✅ <b>Команда {team_num} победила!</b>\n<i>{names_str}</i>\n\n"
                f"🏆 <b>Счёт за вечер:</b>\n{_build_standings()}",
            )
            return

        # ── «итог» ─────────────────────────────────────────────────────────
        if raw_lower == "итог":
            await _safe_send(
                update.message,
                "🏆 <b>Счёт за сегодня:</b>\n\n" + _build_standings(),
            )
            return

        # ── Регистрация ─────────────────────────────────────────────────────
        plus_map: dict[str, int] = {
            "+": 0, "＋": 0,
            "+1": 1, "+ 1": 1, "＋1": 1,
            "+2": 2, "+ 2": 2, "＋2": 2,
            "+3": 3, "+ 3": 3, "＋3": 3,
        }
        if raw in plus_map:
            if not is_open:
                await _safe_send(update.message, "⏰ Запись сейчас закрыта.")
                return
            reg = _register(uid, uname, fname, plus_map[raw])
            await _safe_send(
                update.message,
                _reg_message(display, reg) + "\n\n" + _build_player_list(),
            )
            return

        # ── «-» ────────────────────────────────────────────────────────────
        if raw == "-":
            if not is_open:
                await _safe_send(update.message, "⏰ Запись уже закрыта.")
                return
            was_in, promoted = _unregister(uid)
            if not was_in:
                await _safe_send(update.message, "Тебя не было в списке.")
                return
            text = f"❌ {display} удалён из списка."
            if promoted:
                text += f"\n\n🎉 Из резерва переходят: {', '.join(promoted)}"
            await _safe_send(update.message, text + "\n\n" + _build_player_list())
            return

    except Exception as e:
        logger.error(f"handle_text error: {e}", exc_info=True)
        try:
            await update.message.reply_text("⚠️ Что-то пошло не так. Попробуй ещё раз.")
        except Exception:
            pass


async def error_handler(update: object, context: ContextTypes.DEFAULT_TYPE) -> None:
    logger.error("Необработанная ошибка:", exc_info=context.error)


# ─── Точка входа ─────────────────────────────────────────────────────────────

def main() -> None:
    if not BOT_TOKEN:
        raise RuntimeError("BOT_TOKEN не задан!")
    if not GROUP_CHAT_ID:
        raise RuntimeError("GROUP_CHAT_ID не задан!")

    init_db()

    app = Application.builder().token(BOT_TOKEN).build()

    # Команды администратора
    app.add_handler(CommandHandler("начать",    cmd_nachat))
    app.add_handler(CommandHandler("завершить", cmd_zavershit))
    app.add_handler(CommandHandler("сброс",     cmd_sbros))

    # Общие команды
    app.add_handler(CommandHandler("start",  cmd_start))
    app.add_handler(CommandHandler("status", cmd_status))

    # Текстовые сообщения
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_text))

    app.add_error_handler(error_handler)

    logger.info("Бот запущен. Ожидаю сообщения...")
    app.run_polling(drop_pending_updates=True)


if __name__ == "__main__":
    main()
