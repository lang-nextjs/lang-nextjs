from django.urls import path

from . import views

urlpatterns = [
    # Legacy single-backend route — defaults to deepagents. Kept for E2E
    # compatibility (BACKEND_URL=.../api/chat/stream/ → POST here).
    path("api/chat/stream/", views.chat_stream_legacy),
    # Matrix routes — explicit AI backend in the path.
    path("api/chat/stream/<str:ai_backend>/", views.chat_stream),
    path("health/", views.health),
]
