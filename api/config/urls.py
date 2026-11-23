"""Every route lives under /api/ so Firebase Hosting's /api/** rewrite reaches all of it."""
from django.conf import settings
from django.contrib import admin
from django.urls import include, path

urlpatterns = [
    path('api/', include('core.urls')),
]
if settings.ENABLE_ADMIN:
    # The admin has its own username and password. It stays off on Cloud Run, where only
    # Google sign-in should open the app.
    urlpatterns.insert(0, path('api/admin/', admin.site.urls))
