"""Every route lives under /api/ so Firebase Hosting's /api/** rewrite reaches all of them."""
from django.contrib import admin
from django.urls import include, path

urlpatterns = [
    path('api/admin/', admin.site.urls),
    path('api/', include('core.urls')),
]
