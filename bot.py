import os
import asyncio
import datetime
import random
import logging
import gspread
from oauth2client.service_account import ServiceAccountCredentials
from telegram import Update
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes
from dotenv import load_dotenv

load_dotenv()

# Настройки из переменных окружения
BOT_TOKEN = os.getenv("BOT_TOKEN")
SPREADSHEET_ID = os.getenv("SPREADSHEET_ID")
GROUP_CHAT_ID = int(os.getenv("GROUP_CHAT_ID", 0))
MAX_PLAYERS = 20

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Подключение к Google Таблицам
scope = ['https://spreadsheets.google.com/feeds', 'https://www.googleapis.com/auth/drive']
creds = ServiceAccountCredentials.from_json_keyfile_name('credentials.json', scope)
client = gspread.authorize(creds)
sheet = client.open_by_key(SPREADSHEET_ID)

# Листы
ws_state = sheet.worksheet("game_state")
ws_reg = sheet.worksheet("registrations")

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("Бот манежа Пингвин готов к работе! Пиши + чтобы записаться.")

def _get_state():
    val = ws_state.acell('A1').value
    return int(val) if val else 0

async def register(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if update.message.chat_id != GROUP_CHAT_ID: return
    
    if _get_state() == 0:
        await update.message.reply_text("❌ Запись сейчас закрыта.")
        return

    user = update.message.from_user
    # Простое добавление в таблицу
    ws_reg.append_row([user.id, user.username, user.full_name, datetime.datetime.now().isoformat()])
    await update.message.reply_text(f"✅ {user.full_name}, ты в списке!")

async def open_reg(update: Update, context: ContextTypes.DEFAULT_TYPE):
    # Команда /начать
    ws_state.update('A1', 1)
    await update.message.reply_text("⚽ Регистрация открыта!")

def main():
    app = Application.builder().token(BOT_TOKEN).build()
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("nachat", open_reg))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, register))
    logger.info("Бот запущен...")
    app.run_polling()

if __name__ == "__main__":
    main()
